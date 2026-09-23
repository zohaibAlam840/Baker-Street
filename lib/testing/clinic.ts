/**
 * The full synthetic clinic (spec section 69).
 *
 *   20 patients · 10 RBTs · 3 BCBAs · 3 therapists · 2 OTs ·
 *   2 psychologists · 1 neuropsychologist · 3 clinics · telehealth · home
 *
 * Built on top of the acceptance scenario rather than beside it, so John Reyes
 * keeps his exact 27-of-30-hours setup and the section 77 demo still works
 * while the rest of the building fills up around him.
 *
 * Deterministic: the same seed always produces the same week, so screenshots,
 * tests and demos agree. Generation tracks occupancy directly instead of
 * asking the rule engine — this produces valid data by construction, which is
 * what we want from a fixture. The rule engine's job is to catch problems in
 * real data, not to be load-bearing for the fixture.
 */

import { SLOTS_PER_DAY, SlotRange, minutesToSlots, overlaps } from "../domain/slots";
import type {
  Appointment,
  AppointmentStatus,
  Patient,
  PatientAvailability,
  PatientRestriction,
  PatientServiceRequirement,
  Provider,
  ProviderAvailability,
  ProviderCredential,
  ProviderService,
  ProviderType,
  UUID,
} from "../domain/types";
import type { SnapshotRows } from "../rules/context";
import { ID, TZ, WEEK_START, buildScenarioRows } from "./scenario";

/** Small deterministic PRNG. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  "Amara", "Noah", "Zainab", "Mateo", "Ivy", "Rowan", "Leila", "Kofi", "Sofia",
  "Dmitri", "Hana", "Elias", "Priya", "Tomas", "Nia", "Otto", "Yara", "Caleb",
  "Mira", "Idris", "Freya", "Rafael", "Ada", "Jonas", "Selin", "Omar",
];
const LAST_NAMES = [
  "Bennett", "Alvarez", "Haddad", "Okonkwo", "Lindgren", "Fontaine", "Rossi",
  "Nakamura", "Duarte", "Petrov", "Kaur", "Mbeki", "Novak", "Silva", "Ahmed",
  "Larsen", "Costa", "Weber", "Traore", "Iqbal", "Moreno", "Chen", "Dubois",
];

interface Slot {
  day: number;
  startMinutes: number;
  endMinutes: number;
}

function toRange(slot: Slot): SlotRange {
  return {
    startSlot: slot.day * SLOTS_PER_DAY + minutesToSlots(slot.startMinutes),
    endSlot: slot.day * SLOTS_PER_DAY + minutesToSlots(slot.endMinutes),
  };
}

/** Local wall-clock instant on a horizon day, as ISO. */
function at(dayOffset: number, minutes: number): string {
  // Matches the fixture grid anchoring in scenario.ts.
  const [y, m, d] = WEEK_START.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d + dayOffset);
  // America/New_York is UTC-4 on these September dates.
  const base = utcMidnight + 4 * 60 * 60_000;
  return new Date(base + minutes * 60_000).toISOString();
}

export function buildClinicRows(): SnapshotRows {
  const rows = buildScenarioRows();
  const rnd = mulberry32(20260921);

  // ---------------------------------------------------------------------
  // A third clinic, and rooms to go with every site
  // ---------------------------------------------------------------------
  const clinicEast = "loc-clinic-east";
  rows.locations.push({
    id: clinicEast,
    name: "East Clinic",
    type: "CLINIC",
    city: "Cambridge",
    state: "MA",
    timezone: TZ,
    active: true,
  });

  for (const [locationId, prefix] of [
    [ID.clinicSouth, "South"],
    [clinicEast, "East"],
  ] as const) {
    rows.resources.push(
      {
        id: `res-${prefix.toLowerCase()}-aba-1`,
        name: `${prefix} ABA Room 1`,
        resource_type: "ROOM",
        location_id: locationId,
        capacity: 1,
        active: true,
      },
      {
        id: `res-${prefix.toLowerCase()}-gym`,
        name: `${prefix} OT Gym`,
        resource_type: "GYM",
        location_id: locationId,
        capacity: 2,
        active: true,
      },
      {
        id: `res-${prefix.toLowerCase()}-therapy`,
        name: `${prefix} Therapy Room`,
        resource_type: "ROOM",
        location_id: locationId,
        capacity: 1,
        active: true,
      },
    );

    // Register the new rooms against the services that need one. The
    // required-resource rule matches on these rows, not on room type, so a
    // room that is not registered here cannot satisfy the requirement however
    // suitable it looks.
    rows.serviceResources.push(
      {
        id: `sr-${prefix.toLowerCase()}-ot`,
        service_id: ID.ot,
        resource_id: `res-${prefix.toLowerCase()}-gym`,
        required: true,
      },
      {
        id: `sr-${prefix.toLowerCase()}-therapy`,
        service_id: ID.therapy,
        resource_id: `res-${prefix.toLowerCase()}-therapy`,
        required: true,
      },
      {
        id: `sr-${prefix.toLowerCase()}-np`,
        service_id: ID.neuropsych,
        resource_id: `res-${prefix.toLowerCase()}-therapy`,
        required: true,
      },
    );
  }

  // ---------------------------------------------------------------------
  // Staff, to the section 69 roster
  // ---------------------------------------------------------------------
  const CLINICS = [ID.clinicNorth, ID.clinicSouth, clinicEast];

  // Already present: 4 RBT, 1 BCBA, 1 LMHC, 1 OT.
  const newStaff: { type: ProviderType; count: number; services: UUID[] }[] = [
    { type: "RBT", count: 6, services: [ID.aba] },
    { type: "BCBA", count: 2, services: [ID.supervision, ID.parentTraining, ID.aba] },
    { type: "LCSW", count: 2, services: [ID.therapy] },
    { type: "OT", count: 1, services: [ID.ot] },
    { type: "PSYCHOLOGIST", count: 2, services: [ID.therapy, ID.neuropsych] },
    { type: "NEUROPSYCHOLOGIST", count: 1, services: [ID.neuropsych] },
  ];

  const providers: Provider[] = [];
  const credentials: ProviderCredential[] = [];
  const providerServices: ProviderService[] = [];
  const providerAvailability: ProviderAvailability[] = [];

  let staffIndex = 0;
  for (const group of newStaff) {
    for (let i = 0; i < group.count; i += 1) {
      const id = `prv-${group.type.toLowerCase()}-${i + 10}`;
      const first = FIRST_NAMES[(staffIndex * 7 + 3) % FIRST_NAMES.length];
      const last = LAST_NAMES[(staffIndex * 5 + 1) % LAST_NAMES.length];
      const home = CLINICS[staffIndex % CLINICS.length];

      providers.push({
        id,
        external_id: `${group.type}-${100 + staffIndex}`,
        first_name: first,
        last_name: last,
        provider_type: group.type,
        // One clinician on leave, so the UI has a non-active case to render.
        status: staffIndex === 5 ? "ON_LEAVE" : "ACTIVE",
        timezone: TZ,
        home_location_id: home,
      });

      credentials.push({
        id: `cred-${id}`,
        provider_id: id,
        credential_type: group.type,
        credential_number: `${group.type}-${9000 + staffIndex}`,
        state: "MA",
        issue_date: "2023-02-01",
        // One lapsed certification, so the credential rule has something to bite on.
        expiration_date: staffIndex === 9 ? "2026-09-10" : "2028-03-31",
        status: "ACTIVE",
      });

      for (const serviceId of group.services) {
        providerServices.push({
          id: `ps-${id}-${serviceId}`,
          provider_id: id,
          service_id: serviceId,
          eligible: true,
          effective_start: null,
          effective_end: null,
        });
      }

      // Three shift shapes, so availability is not uniform.
      const shift = staffIndex % 3;
      const [start, end] =
        shift === 0 ? ["08:00", "16:00"] : shift === 1 ? ["10:00", "18:00"] : ["12:00", "20:00"];
      const days = shift === 2 ? [2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];

      for (const day of days) {
        providerAvailability.push({
          id: `prav-${id}-${day}`,
          provider_id: id,
          day_of_week: day as ProviderAvailability["day_of_week"],
          start_time: start,
          end_time: end,
          availability_type: "CLINICAL",
          location_id: home,
          effective_start: null,
          effective_end: null,
        });
      }

      staffIndex += 1;
    }
  }

  rows.providers.push(...providers);
  rows.providerCredentials.push(...credentials);
  rows.providerServices.push(...providerServices);
  rows.providerAvailability.push(...providerAvailability);

  // ---------------------------------------------------------------------
  // 19 more patients (John Reyes is already patient one)
  // ---------------------------------------------------------------------
  const patients: Patient[] = [];
  const patientAvailability: PatientAvailability[] = [];
  const patientRestrictions: PatientRestriction[] = [];
  const requirements: PatientServiceRequirement[] = [];

  for (let i = 0; i < 19; i += 1) {
    const id = `pat-${i + 2}`;
    const first = FIRST_NAMES[(i * 3 + 1) % FIRST_NAMES.length];
    const last = LAST_NAMES[(i * 4 + 6) % LAST_NAMES.length];

    // Age bands drive the demographic chart: 18-30, 31-45, 46-60, 61-70, 70+.
    const band = [18, 31, 46, 61, 71][i % 5];
    const birthYear = 2026 - (band + Math.floor(rnd() * 8));

    patients.push({
      id,
      external_id: `BSH-${1100 + i}`,
      first_name: first,
      last_name: last,
      date_of_birth: `${birthYear}-0${1 + (i % 9)}-1${i % 9}`,
      // Most active; a couple inactive so the dashboard has a real split.
      status: i >= 17 ? "INACTIVE" : "ACTIVE",
      timezone: TZ,
      primary_location_id: CLINICS[i % CLINICS.length],
    });

    // School-age patients get a school block; adults get a work block.
    const isChild = band <= 31;
    for (const day of [1, 2, 3, 4, 5]) {
      patientAvailability.push({
        id: `pav-${id}-${day}`,
        patient_id: id,
        day_of_week: day as PatientAvailability["day_of_week"],
        start_time: "08:00",
        end_time: "19:00",
        availability_type: "AVAILABLE",
        effective_start: null,
        effective_end: null,
      });
      patientRestrictions.push({
        id: `pres-${id}-${day}`,
        patient_id: id,
        restriction_type: isChild ? "SCHOOL" : "WORK",
        day_of_week: day as PatientRestriction["day_of_week"],
        start_time: isChild ? "08:30" : "09:00",
        end_time: isChild ? "12:30" : "15:00",
        service_allowed: null,
        effective_start: null,
        effective_end: null,
      });
    }
    // Two thirds also available Saturday.
    if (i % 3 !== 0) {
      patientAvailability.push({
        id: `pav-${id}-sat`,
        patient_id: id,
        day_of_week: 6,
        start_time: "09:00",
        end_time: "17:00",
        availability_type: "AVAILABLE",
        effective_start: null,
        effective_end: null,
      });
    }

    // Service mix: most on ABA, the rest on other lines.
    const onAba = i % 4 !== 3;
    if (onAba) {
      const target = [10, 15, 20, 25, 30][i % 5];
      requirements.push({
        id: `psr-${id}-aba`,
        patient_id: id,
        service_id: ID.aba,
        minimum_hours_per_week: Math.round(target * 0.6),
        maximum_hours_per_week: target,
        minimum_sessions_per_week: null,
        maximum_sessions_per_week: null,
        target_hours_per_week: target,
        target_sessions_per_week: null,
        required: true,
        priority: 10,
        effective_start: "2026-01-01",
        effective_end: null,
      });
      rows.authorizations.push({
        id: `auth-${id}-aba`,
        patient_id: id,
        service_id: ID.aba,
        payer: ["Commonwealth Health", "Meridian Care", "Statewide Plan"][i % 3],
        authorization_number: `AUTH-${5000 + i}`,
        authorized_hours: target,
        authorized_units: target * 4,
        units_per_hour: 4,
        start_date: "2026-09-21",
        end_date: "2026-09-27",
        status: "ACTIVE",
      });
    }

    // Everyone gets one or two of the non-ABA required services.
    const extras = onAba ? [ID.therapy, ID.ot] : [ID.therapy, ID.ot, ID.neuropsych];
    for (const serviceId of extras.slice(0, 1 + (i % 2))) {
      requirements.push({
        id: `psr-${id}-${serviceId}`,
        patient_id: id,
        service_id: serviceId,
        minimum_hours_per_week: null,
        maximum_hours_per_week: null,
        minimum_sessions_per_week: 1,
        maximum_sessions_per_week: 1,
        target_hours_per_week: null,
        target_sessions_per_week: 1,
        required: true,
        priority: 5,
        effective_start: "2026-01-01",
        effective_end: null,
      });
    }
  }

  rows.patients.push(...patients);
  rows.patientAvailability.push(...patientAvailability);
  rows.patientRestrictions.push(...patientRestrictions);
  rows.patientServiceRequirements.push(...requirements);

  // ---------------------------------------------------------------------
  // A week of appointments, valid by construction
  // ---------------------------------------------------------------------
  const providerBusy = new Map<UUID, SlotRange[]>();
  const resourceBusy = new Map<UUID, SlotRange[]>();
  const patientBusy = new Map<UUID, SlotRange[]>();

  // Seed occupancy with the appointments the acceptance scenario already has.
  for (const appointment of rows.appointments) {
    const range = {
      startSlot: 0,
      endSlot: 0,
    };
    // Recompute from the ISO strings against the same anchoring as `at()`.
    const startMs = new Date(appointment.start_time).getTime();
    const endMs = new Date(appointment.end_time).getTime();
    const [y, m, d] = WEEK_START.split("-").map(Number);
    const weekStartMs = Date.UTC(y, m - 1, d) + 4 * 60 * 60_000;
    range.startSlot = Math.round((startMs - weekStartMs) / 900_000);
    range.endSlot = Math.round((endMs - weekStartMs) / 900_000);

    push(patientBusy, appointment.patient_id, range);
    if (appointment.provider_id) push(providerBusy, appointment.provider_id, range);
  }

  /**
   * Bookable clinicians for a service.
   *
   * Credentials are checked here as well as status: a clinician whose
   * certification has lapsed is not bookable, and a fixture that books them
   * anyway would put data on screen that the rule engine would reject. The
   * lapsed ones exist so the credential rule has something to catch — they
   * should show up as unbookable, not as someone's therapist.
   */
  const eligibleFor = (serviceId: UUID): Provider[] =>
    rows.providers.filter((p) => {
      if (p.status !== "ACTIVE") return false;

      const credentials = rows.providerCredentials.filter((c) => c.provider_id === p.id);
      const hasLiveCredential =
        credentials.length === 0 ||
        credentials.some(
          (c) =>
            c.status === "ACTIVE" &&
            (!c.expiration_date || c.expiration_date >= "2026-09-27"),
        );
      if (!hasLiveCredential) return false;

      return rows.providerServices.some(
        (link) => link.provider_id === p.id && link.service_id === serviceId && link.eligible,
      );
    });

  const appointments: Appointment[] = [];
  let created = 0;

  for (const patient of patients) {
    if (patient.status !== "ACTIVE") continue;

    const patientRequirements = requirements.filter((r) => r.patient_id === patient.id);

    for (const requirement of patientRequirements) {
      const serviceId = requirement.service_id;
      const service = rows.services.find((s) => s.id === serviceId);
      if (!service) continue;

      // ABA runs several long sessions; the rest are single sessions.
      const isHours = requirement.target_hours_per_week != null;
      // Only lengths the service actually offers, or the duration rule rejects it.
      const offered = rows.serviceDurations
        .filter((d) => d.service_id === serviceId && d.active)
        .map((d) => d.duration_minutes)
        .sort((a, b) => a - b);
      const sessionMinutes = isHours
        ? (offered.includes(180) ? 180 : (offered.at(-1) ?? service.default_duration_minutes))
        : (offered.includes(service.default_duration_minutes)
            ? service.default_duration_minutes
            : (offered[0] ?? service.default_duration_minutes));
      // Floor, never round up: rounding up puts the week over its own
      // authorization, which the authorization rule then rejects.
      const sessions = isHours
        ? Math.max(
            1,
            Math.floor(((requirement.target_hours_per_week ?? 3) * 60) / sessionMinutes),
          )
        : 1;

      // Every room registered for this service, so one free at the right site
      // can be picked per appointment.
      const roomOptions = rows.serviceResources
        .filter((link) => link.service_id === serviceId && link.required)
        .map((link) => rows.resources.find((r) => r.id === link.resource_id))
        .filter((r) => r != null);

      const candidates = eligibleFor(serviceId);
      if (candidates.length === 0) continue;

      let placed = 0;
      // Walk days and start times looking for a gap both sides can take.
      for (let day = 0; day <= 5 && placed < sessions; day += 1) {
        // Horizon day 0 is Monday, which is weekday 1. Availability rules are
        // stored by weekday, so the two have to be converted, not conflated.
        const weekday = (day + 1) % 7;

        // When the patient is actually free that day: declared availability,
        // minus school or work. Booking outside this would produce fixture
        // data the rule engine rejects, which makes every screen built on it
        // a lie.
        const patientWindows = availableMinutes(
          rows.patientAvailability.filter((a) => a.patient_id === patient.id),
          rows.patientRestrictions.filter((r) => r.patient_id === patient.id),
          weekday,
        );
        if (patientWindows.length === 0) continue;

        for (let startMinutes = 8 * 60; startMinutes + sessionMinutes <= 20 * 60; startMinutes += 30) {
          if (placed >= sessions) break;

          const endMinutes = startMinutes + sessionMinutes;
          if (!fitsWithin(patientWindows, startMinutes, endMinutes)) continue;

          const slot: Slot = { day, startMinutes, endMinutes };
          const range = toRange(slot);

          if (clashes(patientBusy, patient.id, range)) continue;

          // Prefer a provider the patient already sees, for continuity.
          const ordered = [...candidates].sort(
            (a, b) =>
              countWith(appointments, patient.id, b.id) -
              countWith(appointments, patient.id, a.id),
          );
          const provider = ordered.find((p) => {
            if (clashes(providerBusy, p.id, range)) return false;
            const providerWindows = availableMinutes(
              rows.providerAvailability.filter(
                (a) =>
                  a.provider_id === p.id &&
                  (a.availability_type === "CLINICAL" || a.availability_type === "PREFERRED"),
              ),
              rows.providerAvailability.filter(
                (a) =>
                  a.provider_id === p.id &&
                  (a.availability_type === "PTO" ||
                    a.availability_type === "HARD_UNAVAILABLE"),
              ),
              weekday,
            );
            return fitsWithin(providerWindows, startMinutes, endMinutes);
          });
          if (!provider) continue;

          // A service that needs a room only happens if one is free.
          let room: (typeof roomOptions)[number] | undefined;
          if (roomOptions.length > 0) {
            const atSite = roomOptions.filter(
              (r) => r.location_id === provider.home_location_id,
            );
            room = (atSite.length > 0 ? atSite : roomOptions).find(
              (r) => countBusy(resourceBusy, r.id, range) < r.capacity,
            );
            if (!room) continue;
          }

          const authorization = rows.authorizations.find(
            (a) => a.patient_id === patient.id && a.service_id === serviceId,
          );

          // Days already past are completed; the rest are still to come.
          const status: AppointmentStatus = day < 2 ? "COMPLETED" : "SCHEDULED";

          appointments.push({
            id: `apt-gen-${created}`,
            patient_id: patient.id,
            service_id: serviceId,
            provider_id: provider.id,
            authorization_id: service.requires_authorization
              ? (authorization?.id ?? null)
              : null,
            location_id: provider.home_location_id,
            start_time: at(day, startMinutes),
            end_time: at(day, startMinutes + sessionMinutes),
            status,
            // A realistic spread: required services protected, ABA flexible.
            scheduling_flexibility: requirement.required && !isHours ? "PROTECTED" : "FLEXIBLE",
            telehealth: false,
            original_start_time: null,
            original_provider_id: null,
            original_location_id: null,
          });

          // Attach a registered room that is at this site and not already at
          // capacity for the window.
          if (room) {
            rows.appointmentResources.push({
              appointment_id: `apt-gen-${created}`,
              resource_id: room.id,
            });
            push(resourceBusy, room.id, range);
          }

          push(patientBusy, patient.id, range);
          push(providerBusy, provider.id, range);
          placed += 1;
          created += 1;
        }
      }
    }
  }

  rows.appointments.push(...appointments);
  return rows;
}

function push(map: Map<UUID, SlotRange[]>, key: UUID, range: SlotRange) {
  const bucket = map.get(key);
  if (bucket) bucket.push(range);
  else map.set(key, [range]);
}

function countBusy(map: Map<UUID, SlotRange[]>, key: UUID, range: SlotRange): number {
  return (map.get(key) ?? []).filter((existing) => overlaps(existing, range)).length;
}

function clashes(map: Map<UUID, SlotRange[]>, key: UUID, range: SlotRange): boolean {
  return (map.get(key) ?? []).some((existing) => overlaps(existing, range));
}

interface MinuteWindow {
  start: number;
  end: number;
}

interface WeeklyRow {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

function toMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

/** Open windows on one weekday: `open` rows minus `blocking` rows. */
function availableMinutes(
  open: readonly WeeklyRow[],
  blocking: readonly WeeklyRow[],
  day: number,
): MinuteWindow[] {
  let windows: MinuteWindow[] = open
    .filter((row) => row.day_of_week === day)
    .map((row) => ({ start: toMinutes(row.start_time), end: toMinutes(row.end_time) }));

  for (const block of blocking.filter((row) => row.day_of_week === day)) {
    const cut = { start: toMinutes(block.start_time), end: toMinutes(block.end_time) };
    const next: MinuteWindow[] = [];
    for (const window of windows) {
      if (cut.end <= window.start || cut.start >= window.end) {
        next.push(window);
        continue;
      }
      if (window.start < cut.start) next.push({ start: window.start, end: cut.start });
      if (cut.end < window.end) next.push({ start: cut.end, end: window.end });
    }
    windows = next;
  }
  return windows;
}

function fitsWithin(windows: MinuteWindow[], start: number, end: number): boolean {
  return windows.some((window) => window.start <= start && end <= window.end);
}

function countWith(appointments: Appointment[], patientId: UUID, providerId: UUID): number {
  return appointments.filter((a) => a.patient_id === patientId && a.provider_id === providerId)
    .length;
}
