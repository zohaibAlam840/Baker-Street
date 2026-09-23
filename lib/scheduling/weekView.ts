/**
 * View model for the week grid.
 *
 * Pure projection from a ScheduleContext into something a component can render
 * without knowing about slots, timezones or the rule engine. Keeping it
 * separate means the layout is testable, and the grid never re-derives
 * availability differently from the engine that enforces it.
 */

import {
  SLOTS_PER_DAY,
  SLOT_MINUTES,
  SlotRange,
  slotsToHours,
} from "../domain/slots";
import { formatDateOnly } from "../domain/time";
import type { SchedulingFlexibility, UUID } from "../domain/types";
import { ScheduleContext } from "../rules/context";

/** Department -> categorical colour slot. Fixed order, never cycled. */
export const DEPARTMENT_ORDER = [
  "ABA",
  "Behavioral Health",
  "Rehabilitation",
  "Psychology",
] as const;

/**
 * Departments past the fourth fold into "Other" rather than taking a
 * generated hue: a fifth categorical colour cannot clear the colourblind
 * separation gate against the four already on screen. Identity is carried by
 * the block's own label in every case, so folding costs nothing but the tint.
 */
export function departmentSlot(department: string): number {
  const index = DEPARTMENT_ORDER.indexOf(department as (typeof DEPARTMENT_ORDER)[number]);
  return index === -1 ? 0 : index + 1; // 0 = "Other"
}

export interface WeekDay {
  dayIndex: number;
  date: string; // YYYY-MM-DD
  weekdayLabel: string; // Mon
  dayLabel: string; // 21 Sep
  isToday: boolean;
}

export interface WeekBlock {
  id: UUID;
  dayIndex: number;
  startMinutes: number; // from local midnight
  endMinutes: number;
  durationHours: number;
  serviceName: string;
  serviceCode: string;
  department: string;
  departmentSlot: number;
  /** Provider name on a patient view, patient name on a provider view. */
  counterpart: string;
  locationName: string | null;
  flexibility: SchedulingFlexibility;
  telehealth: boolean;
  startLabel: string; // 13:00
  endLabel: string;
}

export type LayerKind = "available" | "restricted" | "clinical";

export interface WeekLayer {
  dayIndex: number;
  startMinutes: number;
  endMinutes: number;
  kind: LayerKind;
  label?: string;
}

export interface WeekView {
  startDate: string;
  timeZone: string;
  days: WeekDay[];
  /** Vertical extent of the grid, snapped to whole hours. */
  axisStartMinutes: number;
  axisEndMinutes: number;
  blocks: WeekBlock[];
  layers: WeekLayer[];
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Split a slot range into one per-day piece, in local minutes. */
function splitByDay(
  range: SlotRange,
  dayCount: number,
): { dayIndex: number; startMinutes: number; endMinutes: number }[] {
  const out: { dayIndex: number; startMinutes: number; endMinutes: number }[] = [];
  let cursor = range.startSlot;

  while (cursor < range.endSlot) {
    const dayIndex = Math.floor(cursor / SLOTS_PER_DAY);
    if (dayIndex >= dayCount) break;
    const dayEnd = (dayIndex + 1) * SLOTS_PER_DAY;
    const sliceEnd = Math.min(range.endSlot, dayEnd);
    out.push({
      dayIndex,
      startMinutes: (cursor - dayIndex * SLOTS_PER_DAY) * SLOT_MINUTES,
      endMinutes: (sliceEnd - dayIndex * SLOTS_PER_DAY) * SLOT_MINUTES,
    });
    cursor = sliceEnd;
  }
  return out;
}

export interface WeekViewOptions {
  /** Render one patient's week, or one provider's. */
  subject: { kind: "patient"; id: UUID } | { kind: "provider"; id: UUID };
  today?: Date;
}

export function buildWeekView(ctx: ScheduleContext, options: WeekViewOptions): WeekView {
  const { grid } = ctx;
  const todayDate = formatDateOnly(options.today ?? new Date(), grid.timeZone);

  const days: WeekDay[] = [];
  for (let dayIndex = 0; dayIndex < grid.dayCount; dayIndex += 1) {
    const instant = grid.dayStart(dayIndex);
    const date = formatDateOnly(instant, grid.timeZone);
    const [, month, day] = date.split("-").map(Number);
    days.push({
      dayIndex,
      date,
      weekdayLabel: WEEKDAY_LABELS[grid.weekdayOf(dayIndex)],
      dayLabel: `${day} ${MONTH_LABELS[month - 1]}`,
      isToday: date === todayDate,
    });
  }

  // ---------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------
  const appointments =
    options.subject.kind === "patient"
      ? (ctx.appointmentsByPatient.get(options.subject.id) ?? [])
      : (ctx.appointmentsByProvider.get(options.subject.id) ?? []);

  const blocks: WeekBlock[] = [];
  for (const appointment of appointments) {
    const service = ctx.services.get(appointment.service_id);

    const counterpart =
      options.subject.kind === "patient"
        ? (() => {
            const provider = appointment.provider_id
              ? ctx.providers.get(appointment.provider_id)
              : null;
            return provider ? `${provider.first_name} ${provider.last_name}` : "Unassigned";
          })()
        : (() => {
            const patient = ctx.patients.get(appointment.patient_id);
            return patient ? `${patient.first_name} ${patient.last_name}` : "Unknown patient";
          })();

    for (const piece of splitByDay(appointment.range, grid.dayCount)) {
      blocks.push({
        id: appointment.id,
        dayIndex: piece.dayIndex,
        startMinutes: piece.startMinutes,
        endMinutes: piece.endMinutes,
        durationHours: slotsToHours(appointment.range.endSlot - appointment.range.startSlot),
        serviceName: service?.service_name ?? "Unknown service",
        serviceCode: service?.service_code ?? "",
        department: service?.department ?? "Other",
        departmentSlot: departmentSlot(service?.department ?? "Other"),
        counterpart,
        locationName: appointment.location_id
          ? (ctx.locations.get(appointment.location_id)?.name ?? null)
          : null,
        flexibility: appointment.scheduling_flexibility,
        telehealth: appointment.telehealth,
        startLabel: clockLabel(piece.startMinutes),
        endLabel: clockLabel(piece.endMinutes),
      });
    }
  }

  // ---------------------------------------------------------------------
  // Background layers
  // ---------------------------------------------------------------------
  const layers: WeekLayer[] = [];

  if (options.subject.kind === "patient") {
    // Raw declared availability, before restrictions are subtracted, so the
    // school block reads as a hole punched in an available day rather than as
    // undifferentiated dead space.
    for (const row of ctx.patientAvailability.get(options.subject.id) ?? []) {
      if (row.availability_type === "HARD_UNAVAILABLE") continue;
      for (const range of grid.expandWeekly(
        row.day_of_week,
        toMinutes(row.start_time),
        toMinutes(row.end_time),
      )) {
        for (const piece of splitByDay(range, grid.dayCount)) {
          layers.push({ ...piece, kind: "available" });
        }
      }
    }
    for (const row of ctx.patientRestrictions.get(options.subject.id) ?? []) {
      for (const range of grid.expandWeekly(
        row.day_of_week,
        toMinutes(row.start_time),
        toMinutes(row.end_time),
      )) {
        for (const piece of splitByDay(range, grid.dayCount)) {
          layers.push({
            ...piece,
            kind: "restricted",
            label: row.restriction_type.toLowerCase().replace("_", " "),
          });
        }
      }
    }
  } else {
    for (const range of ctx.providerClinicalWindows(options.subject.id)) {
      for (const piece of splitByDay(range, grid.dayCount)) {
        layers.push({ ...piece, kind: "clinical" });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Vertical extent: whole hours around everything on screen
  // ---------------------------------------------------------------------
  const marks = [...blocks, ...layers];
  const earliest = marks.reduce((min, m) => Math.min(min, m.startMinutes), 8 * 60);
  const latest = marks.reduce((max, m) => Math.max(max, m.endMinutes), 18 * 60);

  return {
    startDate: grid.startDate,
    timeZone: grid.timeZone,
    days,
    axisStartMinutes: Math.floor(earliest / 60) * 60,
    axisEndMinutes: Math.ceil(latest / 60) * 60,
    blocks,
    layers,
  };
}

function toMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}
