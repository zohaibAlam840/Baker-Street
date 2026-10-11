/**
 * The hard-constraint rule engine (spec section 6).
 *
 * One implementation, three callers:
 *   1. POST /check-conflict    - answer a user's "can I book this?"
 *   2. candidate generation    - reject candidates before they reach the solver
 *   3. approval revalidation   - re-prove a solution inside the commit transaction
 *
 * Rules are pure functions of (proposal, context). They never query, never
 * mutate, and never throw for ordinary rejections — they return violations.
 */

import {
  SLOTS_PER_DAY,
  SLOT_MINUTES,
  SlotRange,
  overlaps,
  slotsToHours,
  subtractRanges,
} from "../domain/slots";
import { Weekday, formatClockTime, formatDateOnly, parseClockTime } from "../domain/time";
import type { UUID } from "../domain/types";
import { ScheduleContext } from "./context";
import { NO_TRAVEL, TravelModel } from "./travel";
import { Violation, hard, hasHardViolation, soft } from "./violations";

/** A booking under test. Not yet an appointment. */
export interface ProposedBooking {
  patient_id: UUID;
  service_id: UUID;
  provider_id: UUID | null;
  location_id: UUID | null;
  authorization_id: UUID | null;
  resource_ids: UUID[];
  range: SlotRange;
  telehealth: boolean;
  /**
   * Set when re-checking an appointment that already exists, so the engine
   * does not report the appointment as conflicting with itself.
   */
  appointment_id?: UUID;
}

export interface RuleOptions {
  travel?: TravelModel;
  /** Include SOFT violations (preference misses). Off during candidate generation. */
  includeSoft?: boolean;
  /**
   * Appointments the caller intends to remove or move in the same operation,
   * so they should not be treated as occupying time.
   */
  ignoreAppointmentIds?: Iterable<UUID>;
  /** Candidate enumeration needs only the first hard rejection code. */
  stopAfterFirstHard?: boolean;
}

export interface RuleResult {
  valid: boolean;
  violations: Violation[];
}

type Rule = (
  proposal: ProposedBooking,
  ctx: ScheduleContext,
  opts: Required<Pick<RuleOptions, "travel" | "includeSoft">> & {
    ignored: ReadonlySet<UUID>;
  },
) => Violation[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parts of `range` not covered by `windows`. Empty means fully covered. */
function uncoveredParts(range: SlotRange, windows: SlotRange[]): SlotRange[] {
  return subtractRanges([range], windows);
}

function dayIndexOfSlot(slot: number): number {
  return Math.floor(slot / SLOTS_PER_DAY);
}

function describeRange(ctx: ScheduleContext, range: SlotRange): string {
  const start = ctx.grid.instantOf(range.startSlot);
  const end = ctx.grid.instantOf(range.endSlot);
  const tz = ctx.grid.timeZone;
  const startMinutes =
    (start.getTime() - ctx.grid.dayStart(dayIndexOfSlot(range.startSlot)).getTime()) / 60000;
  const endMinutes = startMinutes + (range.endSlot - range.startSlot) * SLOT_MINUTES;
  return `${formatDateOnly(start, tz)} ${formatClockTime(startMinutes)}-${formatClockTime(
    endMinutes % (24 * 60),
  )}${formatDateOnly(end, tz) !== formatDateOnly(start, tz) ? " (+1d)" : ""}`;
}

function durationSlots(range: SlotRange): number {
  return range.endSlot - range.startSlot;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The horizon must actually contain the proposal. */
const withinHorizon: Rule = (proposal, ctx) => {
  const { startSlot, endSlot } = proposal.range;
  if (startSlot < 0 || endSlot > ctx.grid.totalSlots || startSlot >= endSlot) {
    return [
      hard("OUTSIDE_HORIZON", "The requested time falls outside the scheduling window.", {
        range: proposal.range,
      }),
    ];
  }
  return [];
};

/** Patient, provider and service must all be in a usable state. */
const entityState: Rule = (proposal, ctx) => {
  const out: Violation[] = [];

  const patient = ctx.patients.get(proposal.patient_id);
  if (!patient) {
    return [hard("PATIENT_INACTIVE", "Patient not found.", { patient_id: proposal.patient_id })];
  }
  if (patient.status !== "ACTIVE") {
    out.push(
      hard("PATIENT_INACTIVE", `${patient.first_name} ${patient.last_name} is not active.`, {
        patient_id: patient.id,
        detail: { status: patient.status },
      }),
    );
  }

  const service = ctx.services.get(proposal.service_id);
  if (!service) {
    return [
      hard("SERVICE_INACTIVE", "Service not found.", { service_id: proposal.service_id }),
    ];
  }
  if (!service.active) {
    out.push(
      hard("SERVICE_INACTIVE", `${service.service_name} is not an active service.`, {
        service_id: service.id,
      }),
    );
  }

  if (proposal.provider_id) {
    const provider = ctx.providers.get(proposal.provider_id);
    if (!provider) {
      out.push(
        hard("PROVIDER_INACTIVE", "Provider not found.", { provider_id: proposal.provider_id }),
      );
    } else if (provider.status !== "ACTIVE") {
      out.push(
        hard(
          "PROVIDER_INACTIVE",
          `${provider.first_name} ${provider.last_name} is ${provider.status.toLowerCase().replace("_", " ")}.`,
          { provider_id: provider.id, detail: { status: provider.status } },
        ),
      );
    }
  }

  return out;
};

/** The booking length must be one the service actually offers. */
const serviceDuration: Rule = (proposal, ctx) => {
  const service = ctx.services.get(proposal.service_id);
  if (!service) return [];

  const minutes = durationSlots(proposal.range) * SLOT_MINUTES;
  const allowed = ctx.serviceDurations.get(service.id) ?? [];

  if (allowed.length > 0 && !allowed.includes(minutes)) {
    return [
      hard(
        "SERVICE_DURATION_INVALID",
        `${service.service_name} is not offered at ${minutes} minutes (offered: ${allowed.join(", ")}).`,
        { service_id: service.id, detail: { minutes, allowed: allowed.join(",") } },
      ),
    ];
  }

  if (minutes < service.min_duration_minutes || minutes > service.max_duration_minutes) {
    return [
      hard(
        "SERVICE_DURATION_INVALID",
        `${service.service_name} must run between ${service.min_duration_minutes} and ${service.max_duration_minutes} minutes.`,
        { service_id: service.id, detail: { minutes } },
      ),
    ];
  }

  return [];
};

/** Telehealth and in-person are per-service capabilities. */
const serviceModality: Rule = (proposal, ctx) => {
  const service = ctx.services.get(proposal.service_id);
  if (!service) return [];

  if (proposal.telehealth && !service.telehealth_allowed) {
    return [
      hard(
        "SERVICE_MODALITY_NOT_ALLOWED",
        `${service.service_name} cannot be delivered by telehealth.`,
        { service_id: service.id },
      ),
    ];
  }
  if (!proposal.telehealth && !service.in_person_allowed) {
    return [
      hard(
        "SERVICE_MODALITY_NOT_ALLOWED",
        `${service.service_name} cannot be delivered in person.`,
        { service_id: service.id },
      ),
    ];
  }
  return [];
};

/** A patient cannot be in two places at once, whatever the services are. */
const patientOverlap: Rule = (proposal, ctx, opts) => {
  const out: Violation[] = [];
  for (const existing of ctx.appointmentsByPatient.get(proposal.patient_id) ?? []) {
    if (existing.id === proposal.appointment_id || opts.ignored.has(existing.id)) continue;
    if (!overlaps(existing.range, proposal.range)) continue;

    const service = ctx.services.get(existing.service_id);
    out.push(
      hard(
        "PATIENT_OVERLAP",
        `Patient already has ${service?.service_name ?? "an appointment"} at ${describeRange(ctx, existing.range)}.`,
        {
          appointment_id: existing.id,
          patient_id: existing.patient_id,
          service_id: existing.service_id,
          range: existing.range,
          detail: { flexibility: existing.scheduling_flexibility },
        },
      ),
    );
  }
  return out;
};

/** Nor can a provider, regardless of which services are involved. */
const providerOverlap: Rule = (proposal, ctx, opts) => {
  if (!proposal.provider_id) return [];
  const out: Violation[] = [];

  for (const existing of ctx.appointmentsByProvider.get(proposal.provider_id) ?? []) {
    if (existing.id === proposal.appointment_id || opts.ignored.has(existing.id)) continue;
    if (!overlaps(existing.range, proposal.range)) continue;

    const provider = ctx.providers.get(proposal.provider_id);
    out.push(
      hard(
        "PROVIDER_OVERLAP",
        `${provider?.first_name ?? "Provider"} ${provider?.last_name ?? ""} is already booked at ${describeRange(ctx, existing.range)}.`.replace(
          /\s+/g,
          " ",
        ),
        {
          appointment_id: existing.id,
          provider_id: proposal.provider_id,
          range: existing.range,
          detail: { flexibility: existing.scheduling_flexibility },
        },
      ),
    );
  }
  return out;
};

/**
 * Resources respect capacity rather than simple exclusivity: a room with
 * capacity 1 is a no-overlap constraint, a gym with capacity 4 is cumulative.
 */
const resourceCapacity: Rule = (proposal, ctx, opts) => {
  const out: Violation[] = [];

  for (const resourceId of proposal.resource_ids) {
    const resource = ctx.resources.get(resourceId);
    if (!resource) {
      out.push(
        hard("REQUIRED_RESOURCE_MISSING", "Requested resource does not exist.", {
          resource_id: resourceId,
        }),
      );
      continue;
    }
    if (!resource.active) {
      out.push(
        hard("REQUIRED_RESOURCE_MISSING", `${resource.name} is not in service.`, {
          resource_id: resourceId,
        }),
      );
      continue;
    }

    // Peak concurrent usage across the proposed window.
    const concurrent = (ctx.appointmentsByResource.get(resourceId) ?? []).filter(
      (existing) =>
        existing.id !== proposal.appointment_id &&
        !opts.ignored.has(existing.id) &&
        overlaps(existing.range, proposal.range),
    );

    let peak = 0;
    for (let slot = proposal.range.startSlot; slot < proposal.range.endSlot; slot += 1) {
      const atSlot = concurrent.filter(
        (a) => a.range.startSlot <= slot && slot < a.range.endSlot,
      ).length;
      peak = Math.max(peak, atSlot);
    }

    if (peak + 1 > resource.capacity) {
      out.push(
        hard(
          "RESOURCE_OVERLAP",
          `${resource.name} is at capacity (${resource.capacity}) during this window.`,
          {
            resource_id: resourceId,
            appointment_id: concurrent[0]?.id,
            range: proposal.range,
            detail: { capacity: resource.capacity, in_use: peak },
          },
        ),
      );
    }

    if (
      proposal.location_id &&
      resource.location_id &&
      resource.location_id !== proposal.location_id
    ) {
      out.push(
        hard(
          "RESOURCE_WRONG_LOCATION",
          `${resource.name} is not at the selected location.`,
          { resource_id: resourceId, detail: { location_id: proposal.location_id } },
        ),
      );
    }
  }

  return out;
};

/** Services that require a room or equipment must have it attached. */
const requiredResources: Rule = (proposal, ctx) => {
  if (proposal.telehealth) return []; // a telehealth session occupies no room
  const required = (ctx.serviceResources.get(proposal.service_id) ?? []).filter(
    (link) => link.required,
  );
  if (required.length === 0) return [];

  // Any one of the required resources satisfies the requirement — the rows are
  // the set of rooms able to host the service, not a list of simultaneous needs.
  const satisfied = required.some((link) => proposal.resource_ids.includes(link.resource_id));
  if (satisfied) return [];

  const service = ctx.services.get(proposal.service_id);
  const names = required
    .map((link) => ctx.resources.get(link.resource_id)?.name ?? link.resource_id)
    .join(" or ");

  return [
    hard(
      "REQUIRED_RESOURCE_MISSING",
      `${service?.service_name ?? "This service"} requires ${names}.`,
      { service_id: proposal.service_id },
    ),
  ];
};

/** The provider must be flagged eligible for this service, in date. */
const providerEligibility: Rule = (proposal, ctx) => {
  if (!proposal.provider_id) return [];

  const provider = ctx.providers.get(proposal.provider_id);
  const service = ctx.services.get(proposal.service_id);
  const link = ctx.providerServices.get(proposal.provider_id)?.get(proposal.service_id);
  const day = ctx.dateOfSlot(proposal.range.startSlot);

  if (!link || !link.eligible) {
    return [
      hard(
        "PROVIDER_NOT_ELIGIBLE",
        `${provider?.first_name ?? "Provider"} is not eligible to deliver ${service?.service_name ?? "this service"}.`,
        { provider_id: proposal.provider_id, service_id: proposal.service_id },
      ),
    ];
  }

  if (
    (link.effective_start && day < link.effective_start) ||
    (link.effective_end && day > link.effective_end)
  ) {
    return [
      hard(
        "PROVIDER_NOT_ELIGIBLE",
        `${provider?.first_name ?? "Provider"}'s eligibility for ${service?.service_name ?? "this service"} does not cover ${day}.`,
        { provider_id: proposal.provider_id, service_id: proposal.service_id },
      ),
    ];
  }

  return [];
};

/** Credentials must be live on the day of the appointment. */
const providerCredentials: Rule = (proposal, ctx) => {
  if (!proposal.provider_id) return [];

  const credentials = ctx.providerCredentials.get(proposal.provider_id) ?? [];
  if (credentials.length === 0) return []; // nothing recorded, nothing to enforce

  const day = ctx.dateOfSlot(proposal.range.startSlot);
  const endDay = ctx.dateOfSlot(proposal.range.endSlot - 1);
  const live = credentials.filter(
    (c) =>
      c.status === "ACTIVE" &&
      (!c.issue_date || c.issue_date <= day) &&
      (!c.expiration_date || c.expiration_date >= endDay),
  );
  if (live.length > 0) return [];

  const provider = ctx.providers.get(proposal.provider_id);
  const expired = credentials.find((c) => c.expiration_date && c.expiration_date < day);

  return [
    expired
      ? hard(
          "PROVIDER_CREDENTIAL_EXPIRED",
          `${provider?.first_name ?? "Provider"}'s ${expired.credential_type} expired ${expired.expiration_date}.`,
          {
            provider_id: proposal.provider_id,
            detail: {
              credential_type: expired.credential_type,
              expiration_date: expired.expiration_date,
            },
          },
        )
      : hard(
          "PROVIDER_CREDENTIAL_INVALID",
          `${provider?.first_name ?? "Provider"} has no active credential on ${day}.`,
          { provider_id: proposal.provider_id },
        ),
  ];
};

/** The patient must be available for the whole window. */
const patientAvailability: Rule = (proposal, ctx) => {
  const windows = ctx.patientAvailableWindows(proposal.patient_id, proposal.service_id);
  const gaps = uncoveredParts(proposal.range, windows);
  if (gaps.length === 0 && ctx.patientAvailabilityCoversRange(proposal.patient_id, proposal.range)) {
    return [];
  }

  const patient = ctx.patients.get(proposal.patient_id);
  return [
    hard(
      "PATIENT_UNAVAILABLE",
      `${patient?.first_name ?? "Patient"} is not available ${describeRange(ctx, gaps[0] ?? proposal.range)}.`,
      { patient_id: proposal.patient_id, range: gaps[0] ?? proposal.range },
    ),
  ];
};

/** Restrictions get their own code so the UI can say "school", not "unavailable". */
const patientRestrictions: Rule = (proposal, ctx) => {
  const out: Violation[] = [];
  for (const { restriction, range } of ctx.patientRestrictionWindows(
    proposal.patient_id,
    proposal.service_id,
  )) {
    if (overlaps(range, proposal.range)) {
      out.push(
        hard(
          "PATIENT_RESTRICTED",
          `Blocked by ${restriction.restriction_type.toLowerCase().replace("_", " ")} ${describeRange(ctx, range)}.`,
          {
            patient_id: proposal.patient_id,
            range,
            detail: { restriction_type: restriction.restriction_type },
          },
        ),
      );
    }
  }
  return out;
};

/** The provider must be inside clinical hours and not on PTO. */
const providerAvailability: Rule = (proposal, ctx) => {
  if (!proposal.provider_id) return [];

  const windows = ctx.providerClinicalWindows(proposal.provider_id);
  const gaps = uncoveredParts(proposal.range, windows);
  const locations = ctx.providerLocationsForRange(proposal.provider_id, proposal.range);
  const locationAllowed = proposal.telehealth
    ? locations.length > 0
    : locations.includes(proposal.location_id);
  if (gaps.length === 0 && locationAllowed) return [];

  const provider = ctx.providers.get(proposal.provider_id);
  return [
    hard(
      "PROVIDER_UNAVAILABLE",
      `${provider?.first_name ?? "Provider"} is not available at the selected location ${describeRange(ctx, gaps[0] ?? proposal.range)}.`,
      { provider_id: proposal.provider_id, range: gaps[0] ?? proposal.range },
    ),
  ];
};

/**
 * Authorization is a ceiling, never a requirement (spec section 10). This rule
 * only ever says "you have exceeded it" — it never says "you must use it all".
 */
const authorization: Rule = (proposal, ctx, opts) => {
  const service = ctx.services.get(proposal.service_id);
  if (!service) return [];

  if (!service.requires_authorization) return [];

  if (!proposal.authorization_id) {
    return [
      hard(
        "AUTHORIZATION_MISSING",
        `${service.service_name} requires an authorization.`,
        { service_id: service.id, patient_id: proposal.patient_id },
      ),
    ];
  }

  const auth = (ctx.authorizations.get(proposal.patient_id) ?? []).find(
    (a) => a.id === proposal.authorization_id,
  );
  if (!auth) {
    return [
      hard("AUTHORIZATION_MISSING", "Authorization not found for this patient.", {
        authorization_id: proposal.authorization_id,
        patient_id: proposal.patient_id,
      }),
    ];
  }

  const out: Violation[] = [];

  if (auth.service_id !== proposal.service_id) {
    out.push(
      hard(
        "AUTHORIZATION_SERVICE_MISMATCH",
        `Authorization ${auth.authorization_number ?? auth.id} is not for ${service.service_name}.`,
        { authorization_id: auth.id, service_id: proposal.service_id },
      ),
    );
  }

  if (auth.status !== "ACTIVE") {
    out.push(
      hard(
        "AUTHORIZATION_EXPIRED",
        `Authorization ${auth.authorization_number ?? auth.id} is ${auth.status.toLowerCase()}.`,
        { authorization_id: auth.id, detail: { status: auth.status } },
      ),
    );
  }

  const startDay = ctx.dateOfSlot(proposal.range.startSlot);
  const endDay = ctx.dateOfSlot(proposal.range.endSlot - 1);
  if (startDay < auth.start_date || endDay > auth.end_date) {
    out.push(
      hard(
        "AUTHORIZATION_EXPIRED",
        `Appointment on ${startDay} falls outside the authorization period (${auth.start_date} to ${auth.end_date}).`,
        { authorization_id: auth.id, detail: { start: auth.start_date, end: auth.end_date } },
      ),
    );
  }

  const authorizedHours =
    auth.authorized_hours ??
    (auth.authorized_units != null && auth.units_per_hour > 0
      ? auth.authorized_units / auth.units_per_hour
      : null);
  if (authorizedHours != null) {
    const authorizedSlots = Math.round(authorizedHours * 4);
    let usedSlots = ctx.slotsUsedAgainstAuthorization(auth.id, proposal.appointment_id);
    for (const ignoredId of opts.ignored) {
      const ignored = ctx.appointments.find((a) => a.id === ignoredId);
      if (ignored?.authorization_id === auth.id) {
        usedSlots -= durationSlots(ignored.range);
      }
    }
    const wouldUse = usedSlots + durationSlots(proposal.range);

    if (wouldUse > authorizedSlots) {
      out.push(
        hard(
          "AUTHORIZATION_EXCEEDED",
          `Would book ${slotsToHours(wouldUse)}h against ${authorizedHours}h authorized (${slotsToHours(Math.max(0, authorizedSlots - usedSlots))}h remaining).`,
          {
            authorization_id: auth.id,
            detail: {
              authorized_hours: authorizedHours,
              scheduled_hours: slotsToHours(usedSlots),
              remaining_hours: slotsToHours(Math.max(0, authorizedSlots - usedSlots)),
              requested_hours: slotsToHours(durationSlots(proposal.range)),
            },
          },
        ),
      );
    }
  }

  return out;
};

/**
 * A provider physically travelling between locations needs time to do it
 * (spec section 40). Configuration decides whether that is hard or costly.
 */
const travelTime: Rule = (proposal, ctx, opts) => {
  if (!proposal.provider_id || proposal.telehealth) return [];

  const neighbours = (ctx.appointmentsByProvider.get(proposal.provider_id) ?? []).filter(
    (a) =>
      a.id !== proposal.appointment_id && !opts.ignored.has(a.id) && !a.telehealth,
  );

  const out: Violation[] = [];
  for (const neighbour of neighbours) {
    if (overlaps(neighbour.range, proposal.range)) continue; // already an overlap violation

    const gapSlots =
      neighbour.range.startSlot >= proposal.range.endSlot
        ? neighbour.range.startSlot - proposal.range.endSlot
        : proposal.range.startSlot - neighbour.range.endSlot;

    const needed =
      neighbour.range.startSlot >= proposal.range.endSlot
        ? opts.travel.minutesBetween(proposal.location_id, neighbour.location_id)
        : opts.travel.minutesBetween(neighbour.location_id, proposal.location_id);

    if (needed === 0) continue;
    // Only adjacent appointments matter; a full day apart is never a problem.
    if (gapSlots * SLOT_MINUTES >= needed) continue;

    const message = `Only ${gapSlots * SLOT_MINUTES} min between this and the appointment at ${describeRange(ctx, neighbour.range)}, but travel needs ${needed} min.`;
    out.push(
      opts.travel.enforceAsHardConstraint
        ? hard("TRAVEL_TIME_INSUFFICIENT", message, {
            appointment_id: neighbour.id,
            provider_id: proposal.provider_id,
            detail: { gap_minutes: gapSlots * SLOT_MINUTES, travel_minutes: needed },
          })
        : soft("TRAVEL_TIME_INSUFFICIENT", message, {
            appointment_id: neighbour.id,
            provider_id: proposal.provider_id,
            detail: { gap_minutes: gapSlots * SLOT_MINUTES, travel_minutes: needed },
          }),
    );
  }
  return out;
};

/** A LOCKED appointment cannot be moved, reassigned or relocated (spec 38). */
const lockedAppointment: Rule = (proposal, ctx) => {
  if (!proposal.appointment_id) return [];
  const existing = ctx.appointments.find((a) => a.id === proposal.appointment_id);
  if (!existing || existing.scheduling_flexibility !== "LOCKED") return [];

  const moved =
    existing.range.startSlot !== proposal.range.startSlot ||
    existing.range.endSlot !== proposal.range.endSlot;
  const reassigned = existing.provider_id !== proposal.provider_id;
  const relocated = existing.location_id !== proposal.location_id;

  if (!moved && !reassigned && !relocated) return [];

  return [
    hard("APPOINTMENT_LOCKED", "This appointment is locked and cannot be changed.", {
      appointment_id: existing.id,
      detail: { moved, reassigned, relocated },
    }),
  ];
};

/** Preferences are soft unless a row is explicitly designated hard (spec 16). */
const patientPreferences: Rule = (proposal, ctx, opts) => {
  const out: Violation[] = [];
  const prefs = (ctx.patientPreferences.get(proposal.patient_id) ?? []).filter(
    (p) => !p.preferred_service_id || p.preferred_service_id === proposal.service_id,
  );

  for (const pref of prefs) {
    if (!pref.is_hard_constraint && !opts.includeSoft) continue;

    const misses: string[] = [];

    if (pref.preferred_provider_id && pref.preferred_provider_id !== proposal.provider_id) {
      const wanted = ctx.providers.get(pref.preferred_provider_id);
      misses.push(`preferred provider ${wanted?.first_name ?? ""} ${wanted?.last_name ?? ""}`.trim());
    }
    if (pref.preferred_location_id && pref.preferred_location_id !== proposal.location_id) {
      misses.push(`preferred location ${ctx.locations.get(pref.preferred_location_id)?.name ?? ""}`.trim());
    }
    const bookedWeekday = ctx.grid.weekdayOf(dayIndexOfSlot(proposal.range.startSlot));

    if (pref.preferred_day != null && bookedWeekday !== pref.preferred_day) {
      misses.push("preferred day");
    }
    if (pref.preferred_start_time && pref.preferred_end_time) {
      // Checked against the booked day, so a time-of-day preference reads as a
      // miss on its own rather than doubling up with the preferred-day miss.
      const window = ctx.grid.expandWeekly(
        bookedWeekday as Weekday,
        parseClockTime(pref.preferred_start_time),
        parseClockTime(pref.preferred_end_time),
      );
      if (uncoveredParts(proposal.range, window).length > 0) misses.push("preferred time");
    }

    if (misses.length === 0) continue;

    const message = `Does not match ${misses.join(", ")}.`;
    out.push(
      pref.is_hard_constraint
        ? hard("HARD_PREFERENCE_VIOLATED", message, {
            patient_id: proposal.patient_id,
            detail: { priority: pref.priority },
          })
        : soft("HARD_PREFERENCE_VIOLATED", message, {
            patient_id: proposal.patient_id,
            detail: { priority: pref.priority },
          }),
    );
  }

  return out;
};

/**
 * Order matters only for readability of the output — every rule runs. Cheap,
 * high-signal rules come first so the first reported reason is the useful one.
 */
const RULES: Rule[] = [
  withinHorizon,
  (proposal, ctx) =>
    ctx.grid.isValidWallClockRange(proposal.range)
      ? []
      : [
          hard(
            "LOCAL_TIME_INVALID",
            "This wall-clock time does not exist or is ambiguous because of daylight saving time.",
            { range: proposal.range },
          ),
        ],
  entityState,
  serviceDuration,
  serviceModality,
  lockedAppointment,
  providerEligibility,
  providerCredentials,
  patientOverlap,
  providerOverlap,
  patientRestrictions,
  patientAvailability,
  providerAvailability,
  requiredResources,
  resourceCapacity,
  authorization,
  travelTime,
  patientPreferences,
];

/**
 * Run every rule against a proposal.
 *
 * Always runs all rules rather than short-circuiting: a user fixing one
 * conflict wants to see the other three too, and section 67's explanations
 * need the complete set of limiting factors.
 */
export function evaluateBooking(
  proposal: ProposedBooking,
  ctx: ScheduleContext,
  options: RuleOptions = {},
): RuleResult {
  const opts = {
    travel: options.travel ?? NO_TRAVEL,
    includeSoft: options.includeSoft ?? false,
    ignored:
      options.ignoreAppointmentIds instanceof Set
        ? options.ignoreAppointmentIds
        : new Set(options.ignoreAppointmentIds ?? []),
  };

  const violations: Violation[] = [];
  for (const rule of RULES) {
    const found = rule(proposal, ctx, opts);
    violations.push(...found);
    if (options.stopAfterFirstHard && hasHardViolation(found)) break;
  }

  return { valid: !hasHardViolation(violations), violations };
}

/** Fast path for candidate generation: hard constraints only, no soft output. */
export function isFeasible(
  proposal: ProposedBooking,
  ctx: ScheduleContext,
  travel?: TravelModel,
): boolean {
  return evaluateBooking(proposal, ctx, { travel, includeSoft: false }).valid;
}
