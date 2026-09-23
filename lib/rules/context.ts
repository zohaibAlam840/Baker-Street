/**
 * The in-memory snapshot every rule reads from.
 *
 * Loading happens once per request; the rules themselves never touch the
 * database. That keeps them pure and fast enough to run thousands of times
 * during candidate generation, and it is what lets the what-if engine (spec
 * section 50) clone a scenario without writing to production data.
 */

import {
  SLOTS_PER_DAY,
  SlotGrid,
  SlotRange,
  intersectAll,
  mergeRanges,
  subtractRanges,
} from "../domain/slots";
import { formatDateOnly, parseClockTime, withinEffectiveRange } from "../domain/time";
import {
  Appointment,
  Authorization,
  Location,
  Patient,
  PatientAvailability,
  PatientPreference,
  PatientRestriction,
  PatientServiceRequirement,
  Provider,
  ProviderAvailability,
  ProviderCredential,
  ProviderService,
  Resource,
  Service,
  ServiceDuration,
  ServiceResource,
  UUID,
  occupiesTime,
} from "../domain/types";

/** An existing appointment with its slot range already resolved. */
export interface BookedAppointment extends Appointment {
  range: SlotRange;
  resource_ids: UUID[];
}

export interface SnapshotRows {
  patients: Patient[];
  services: Service[];
  serviceDurations: ServiceDuration[];
  serviceResources: ServiceResource[];
  providers: Provider[];
  providerServices: ProviderService[];
  providerCredentials: ProviderCredential[];
  providerAvailability: ProviderAvailability[];
  patientAvailability: PatientAvailability[];
  patientRestrictions: PatientRestriction[];
  patientPreferences: PatientPreference[];
  patientServiceRequirements: PatientServiceRequirement[];
  authorizations: Authorization[];
  locations: Location[];
  resources: Resource[];
  appointments: Appointment[];
  appointmentResources: { appointment_id: UUID; resource_id: UUID }[];
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function index<T>(rows: readonly T[], key: (row: T) => UUID): Map<UUID, T> {
  return new Map(rows.map((row) => [key(row), row]));
}

export class ScheduleContext {
  readonly grid: SlotGrid;

  readonly patients: Map<UUID, Patient>;
  readonly services: Map<UUID, Service>;
  readonly providers: Map<UUID, Provider>;
  readonly locations: Map<UUID, Location>;
  readonly resources: Map<UUID, Resource>;

  readonly serviceDurations: Map<UUID, number[]>;
  readonly serviceResources: Map<UUID, ServiceResource[]>;
  readonly providerServices: Map<UUID, Map<UUID, ProviderService>>;
  readonly providerCredentials: Map<UUID, ProviderCredential[]>;
  readonly providerAvailability: Map<UUID, ProviderAvailability[]>;
  readonly patientAvailability: Map<UUID, PatientAvailability[]>;
  readonly patientRestrictions: Map<UUID, PatientRestriction[]>;
  readonly patientPreferences: Map<UUID, PatientPreference[]>;
  readonly patientServiceRequirements: Map<UUID, PatientServiceRequirement[]>;
  readonly authorizations: Map<UUID, Authorization[]>;

  readonly appointments: BookedAppointment[];
  readonly appointmentsByPatient: Map<UUID, BookedAppointment[]>;
  readonly appointmentsByProvider: Map<UUID, BookedAppointment[]>;
  readonly appointmentsByResource: Map<UUID, BookedAppointment[]>;

  /** The rows this snapshot was built from, so it can be extended or cloned. */
  readonly rows: SnapshotRows;

  private readonly windowCache = new Map<string, SlotRange[]>();
  /**
   * Local date per horizon day, resolved once.
   *
   * The date rules (authorization period, credential expiry, eligibility
   * dates) need the calendar date of a slot, and candidate generation calls
   * them once per candidate — tens of thousands of times. Formatting through
   * Intl on each call dominated the profile, and a week only ever has seven
   * answers.
   */
  private readonly dayDates: string[];

  constructor(grid: SlotGrid, rows: SnapshotRows) {
    this.grid = grid;
    this.rows = rows;

    this.dayDates = Array.from({ length: grid.dayCount }, (_, dayIndex) =>
      formatDateOnly(grid.dayStart(dayIndex), grid.timeZone),
    );

    this.patients = index(rows.patients, (r) => r.id);
    this.services = index(rows.services, (r) => r.id);
    this.providers = index(rows.providers, (r) => r.id);
    this.locations = index(rows.locations, (r) => r.id);
    this.resources = index(rows.resources, (r) => r.id);

    this.serviceDurations = new Map(
      [...groupBy(rows.serviceDurations.filter((d) => d.active), (d) => d.service_id)].map(
        ([serviceId, durations]) => [
          serviceId,
          durations.map((d) => d.duration_minutes).sort((a, b) => a - b),
        ],
      ),
    );
    this.serviceResources = groupBy(rows.serviceResources, (r) => r.service_id);

    this.providerServices = new Map(
      [...groupBy(rows.providerServices, (r) => r.provider_id)].map(
        ([providerId, links]) => [providerId, index(links, (l) => l.service_id)],
      ),
    );
    this.providerCredentials = groupBy(rows.providerCredentials, (r) => r.provider_id);
    this.providerAvailability = groupBy(rows.providerAvailability, (r) => r.provider_id);

    this.patientAvailability = groupBy(rows.patientAvailability, (r) => r.patient_id);
    this.patientRestrictions = groupBy(rows.patientRestrictions, (r) => r.patient_id);
    this.patientPreferences = groupBy(rows.patientPreferences, (r) => r.patient_id);
    this.patientServiceRequirements = groupBy(
      rows.patientServiceRequirements,
      (r) => r.patient_id,
    );
    this.authorizations = groupBy(rows.authorizations, (r) => r.patient_id);

    const resourcesByAppointment = groupBy(
      rows.appointmentResources,
      (r) => r.appointment_id,
    );

    this.appointments = [];
    for (const appointment of rows.appointments) {
      if (!occupiesTime(appointment)) continue;
      const range = grid.rangeOf(
        new Date(appointment.start_time),
        new Date(appointment.end_time),
      );
      if (!range) continue; // falls entirely outside the horizon
      this.appointments.push({
        ...appointment,
        range,
        resource_ids:
          resourcesByAppointment.get(appointment.id)?.map((r) => r.resource_id) ?? [],
      });
    }

    this.appointmentsByPatient = groupBy(this.appointments, (a) => a.patient_id);
    this.appointmentsByProvider = groupBy(
      this.appointments.filter((a) => a.provider_id),
      (a) => a.provider_id as UUID,
    );
    this.appointmentsByResource = new Map();
    for (const appointment of this.appointments) {
      for (const resourceId of appointment.resource_ids) {
        const bucket = this.appointmentsByResource.get(resourceId);
        if (bucket) bucket.push(appointment);
        else this.appointmentsByResource.set(resourceId, [appointment]);
      }
    }
  }

  /** Local calendar date ("YYYY-MM-DD") of the day a slot falls on. */
  dateOfSlot(slot: number): string {
    const dayIndex = Math.min(
      this.dayDates.length - 1,
      Math.max(0, Math.floor(slot / SLOTS_PER_DAY)),
    );
    return this.dayDates[dayIndex];
  }

  /**
   * A new snapshot with extra appointments added, leaving this one untouched.
   *
   * This is how a scenario is explored without writing anything: greedy fill,
   * and later the what-if engine (spec section 50), place provisional
   * appointments and re-evaluate against a context that includes them. The
   * spec is explicit that what-if must never modify production data, so the
   * only mutation available is building a new snapshot.
   */
  withExtraAppointments(
    extra: readonly Appointment[],
    extraResources: readonly { appointment_id: UUID; resource_id: UUID }[] = [],
  ): ScheduleContext {
    return new ScheduleContext(this.grid, {
      ...this.rows,
      appointments: [...this.rows.appointments, ...extra],
      appointmentResources: [...this.rows.appointmentResources, ...extraResources],
    });
  }

  // -------------------------------------------------------------------------
  // Derived availability windows
  // -------------------------------------------------------------------------

  /**
   * Slot windows in which a provider may see patients: their CLINICAL (and
   * PREFERRED) blocks, minus PTO and explicit hard-unavailable blocks.
   */
  providerClinicalWindows(providerId: UUID): SlotRange[] {
    return this.cached(`provider:${providerId}`, () => {
      const rows = this.providerAvailability.get(providerId) ?? [];
      const open: SlotRange[] = [];
      const closed: SlotRange[] = [];
      for (const row of rows) {
        const ranges = this.expand(row.day_of_week, row.start_time, row.end_time, row);
        if (row.availability_type === "PTO" || row.availability_type === "HARD_UNAVAILABLE") {
          closed.push(...ranges);
        } else if (
          row.availability_type === "CLINICAL" ||
          row.availability_type === "PREFERRED"
        ) {
          open.push(...ranges);
        }
        // ADMINISTRATIVE time is neither bookable nor blocking for patients.
      }
      return subtractRanges(open, closed);
    });
  }

  /** A provider's PREFERRED windows, used only for ranking. */
  providerPreferredWindows(providerId: UUID): SlotRange[] {
    return this.cached(`provider-pref:${providerId}`, () =>
      mergeRanges(
        (this.providerAvailability.get(providerId) ?? [])
          .filter((row) => row.availability_type === "PREFERRED")
          .flatMap((row) => this.expand(row.day_of_week, row.start_time, row.end_time, row)),
      ),
    );
  }

  /**
   * Windows in which a patient can be seen for `serviceId`: declared
   * availability, minus hard-unavailable blocks, minus restrictions that do
   * not permit this service.
   */
  patientAvailableWindows(patientId: UUID, serviceId: UUID | null = null): SlotRange[] {
    return this.cached(`patient:${patientId}:${serviceId ?? "any"}`, () => {
      const rows = this.patientAvailability.get(patientId) ?? [];
      const open: SlotRange[] = [];
      const closed: SlotRange[] = [];
      for (const row of rows) {
        const ranges = this.expand(row.day_of_week, row.start_time, row.end_time, row);
        if (row.availability_type === "HARD_UNAVAILABLE") closed.push(...ranges);
        else open.push(...ranges);
      }
      closed.push(...this.patientBlockedWindows(patientId, serviceId));
      return subtractRanges(open, closed);
    });
  }

  /**
   * Restriction windows (school, work, other appointments) that block
   * `serviceId`. A restriction naming a `service_allowed` blocks everything
   * except that service.
   */
  patientBlockedWindows(patientId: UUID, serviceId: UUID | null = null): SlotRange[] {
    const rows = this.patientRestrictions.get(patientId) ?? [];
    const blocked: SlotRange[] = [];
    for (const row of rows) {
      if (serviceId && row.service_allowed === serviceId) continue;
      blocked.push(...this.expand(row.day_of_week, row.start_time, row.end_time, row));
    }
    return mergeRanges(blocked);
  }

  /** Windows where patient and provider are both free to meet. */
  meetingWindows(patientId: UUID, providerId: UUID, serviceId: UUID): SlotRange[] {
    return intersectAll(
      this.patientAvailableWindows(patientId, serviceId),
      this.providerClinicalWindows(providerId),
    );
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** Providers flagged eligible for a service and currently active. */
  eligibleProviders(serviceId: UUID): Provider[] {
    const out: Provider[] = [];
    for (const provider of this.providers.values()) {
      if (provider.status !== "ACTIVE") continue;
      const link = this.providerServices.get(provider.id)?.get(serviceId);
      if (link?.eligible) out.push(provider);
    }
    return out;
  }

  /** Authorizations for a patient/service pair, newest period first. */
  authorizationsFor(patientId: UUID, serviceId: UUID): Authorization[] {
    return (this.authorizations.get(patientId) ?? [])
      .filter((a) => a.service_id === serviceId)
      .sort((a, b) => b.start_date.localeCompare(a.start_date));
  }

  requirementFor(patientId: UUID, serviceId: UUID): PatientServiceRequirement | null {
    return (
      (this.patientServiceRequirements.get(patientId) ?? []).find(
        (r) => r.service_id === serviceId,
      ) ?? null
    );
  }

  /** Slots already consumed against an authorization inside this horizon. */
  slotsUsedAgainstAuthorization(authorizationId: UUID, excludeAppointmentId?: UUID): number {
    let total = 0;
    for (const appointment of this.appointments) {
      if (appointment.authorization_id !== authorizationId) continue;
      if (appointment.id === excludeAppointmentId) continue;
      total += appointment.range.endSlot - appointment.range.startSlot;
    }
    return total;
  }

  /** Slots scheduled for a patient/service pair inside this horizon. */
  slotsScheduled(patientId: UUID, serviceId: UUID, excludeAppointmentId?: UUID): number {
    let total = 0;
    for (const appointment of this.appointmentsByPatient.get(patientId) ?? []) {
      if (appointment.service_id !== serviceId) continue;
      if (appointment.id === excludeAppointmentId) continue;
      total += appointment.range.endSlot - appointment.range.startSlot;
    }
    return total;
  }

  /** Session count for a patient/service pair inside this horizon. */
  sessionsScheduled(patientId: UUID, serviceId: UUID, excludeAppointmentId?: UUID): number {
    return (this.appointmentsByPatient.get(patientId) ?? []).filter(
      (a) => a.service_id === serviceId && a.id !== excludeAppointmentId,
    ).length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private expand(
    dayOfWeek: number,
    startTime: string,
    endTime: string,
    row: { effective_start: string | null; effective_end: string | null },
  ): SlotRange[] {
    const ranges = this.grid.expandWeekly(
      dayOfWeek as Parameters<SlotGrid["expandWeekly"]>[0],
      parseClockTime(startTime),
      parseClockTime(endTime),
    );
    // A weekly rule can be effective for only part of the horizon, so each
    // expanded day is filtered on its own date rather than the horizon's.
    return ranges.filter((range) =>
      withinEffectiveRange(
        this.grid.instantOf(range.startSlot),
        this.grid.timeZone,
        row.effective_start,
        row.effective_end,
      ),
    );
  }

  private cached(key: string, compute: () => SlotRange[]): SlotRange[] {
    let value = this.windowCache.get(key);
    if (!value) {
      value = compute();
      this.windowCache.set(key, value);
    }
    return value;
  }
}
