import type { LocationType, OptimizationObjective } from "@/lib/domain/types";

export const LOCATION_TYPES = [
  "CLINIC",
  "HOME",
  "SCHOOL",
  "COMMUNITY",
  "TELEHEALTH",
] as const satisfies readonly LocationType[];

export const CONFIGURATION_OBJECTIVES = [
  "MAXIMIZE_SERVICE_HOURS",
  "MAXIMIZE_SERVICE_SESSIONS",
  "MAXIMIZE_AUTHORIZATION_UTILIZATION",
  "COMPLETE_REQUIRED_SERVICES",
  "MAXIMIZE_PROVIDER_CONTINUITY",
  "MINIMIZE_TRAVEL",
] as const satisfies readonly OptimizationObjective[];

export interface LocationConfigurationInput {
  name: string;
  type: LocationType;
  city: string | null;
  state: string | null;
  timezone: string;
  active: boolean;
}

export interface ResourceConfigurationInput {
  name: string;
  resourceType: string;
  capacity: number;
  locationId: string | null;
  active: boolean;
}

export interface ServiceConfigurationInput {
  name: string;
  code: string;
  department: string;
  durations: number[];
  defaultDuration: number;
  primaryObjective: (typeof CONFIGURATION_OBJECTIVES)[number];
  requiresAuthorization: boolean;
  inPersonAllowed: boolean;
  telehealthAllowed: boolean;
  groupAllowed: boolean;
  active: boolean;
  resourceIds: string[];
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanRequired(value: string, label: string, maxLength: number): ValidationResult<string> {
  const cleaned = value.trim();
  if (!cleaned) return { ok: false, error: `${label} is required.` };
  if (cleaned.length > maxLength) {
    return { ok: false, error: `${label} must be ${maxLength} characters or fewer.` };
  }
  return { ok: true, value: cleaned };
}

function cleanOptional(value: string, label: string, maxLength: number): ValidationResult<string | null> {
  const cleaned = value.trim();
  if (cleaned.length > maxLength) {
    return { ok: false, error: `${label} must be ${maxLength} characters or fewer.` };
  }
  return { ok: true, value: cleaned || null };
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parseLocationConfiguration(raw: {
  name: string;
  type: string;
  city: string;
  state: string;
  timezone: string;
  active: boolean;
}): ValidationResult<LocationConfigurationInput> {
  const name = cleanRequired(raw.name, "Location name", 120);
  if (!name.ok) return name;
  if (!LOCATION_TYPES.includes(raw.type as LocationType)) {
    return { ok: false, error: "Choose a valid location type." };
  }
  const city = cleanOptional(raw.city, "City", 100);
  if (!city.ok) return city;
  const state = cleanOptional(raw.state, "State", 100);
  if (!state.ok) return state;
  const timezone = cleanRequired(raw.timezone, "Timezone", 100);
  if (!timezone.ok) return timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone.value }).format();
  } catch {
    return { ok: false, error: "Enter a valid IANA timezone, such as America/New_York." };
  }

  return {
    ok: true,
    value: {
      name: name.value,
      type: raw.type as LocationType,
      city: city.value,
      state: state.value,
      timezone: timezone.value,
      active: raw.active,
    },
  };
}

export function parseResourceConfiguration(raw: {
  name: string;
  resourceType: string;
  capacity: string;
  locationId: string;
  active: boolean;
}): ValidationResult<ResourceConfigurationInput> {
  const name = cleanRequired(raw.name, "Resource name", 120);
  if (!name.ok) return name;
  const resourceType = cleanRequired(raw.resourceType, "Resource type", 80);
  if (!resourceType.ok) return resourceType;
  const capacity = Number(raw.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10_000) {
    return { ok: false, error: "Capacity must be a whole number between 1 and 10,000." };
  }
  const locationId = raw.locationId.trim();
  if (locationId && !isUuid(locationId)) {
    return { ok: false, error: "Choose a valid location." };
  }

  return {
    ok: true,
    value: {
      name: name.value,
      resourceType: resourceType.value,
      capacity,
      locationId: locationId || null,
      active: raw.active,
    },
  };
}

export function parseServiceConfiguration(raw: {
  name: string;
  code: string;
  department: string;
  durations: string;
  defaultDuration: string;
  primaryObjective: string;
  requiresAuthorization: boolean;
  inPersonAllowed: boolean;
  telehealthAllowed: boolean;
  groupAllowed: boolean;
  active: boolean;
  resourceIds: string[];
}): ValidationResult<ServiceConfigurationInput> {
  const name = cleanRequired(raw.name, "Service name", 120);
  if (!name.ok) return name;
  const code = raw.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) {
    return { ok: false, error: "Service code must be 2–32 letters, numbers, underscores, or hyphens." };
  }
  const department = cleanRequired(raw.department, "Department", 120);
  if (!department.ok) return department;

  const durationParts = raw.durations.split(",").map((item) => item.trim()).filter(Boolean);
  const durations = [...new Set(durationParts.map(Number))].sort((a, b) => a - b);
  if (
    durationParts.length === 0
    || durations.some((duration) => !Number.isInteger(duration) || duration < 15 || duration > 1_440 || duration % 15 !== 0)
  ) {
    return { ok: false, error: "Allowed durations must be comma-separated 15-minute increments between 15 and 1,440." };
  }
  const defaultDuration = Number(raw.defaultDuration);
  if (!Number.isInteger(defaultDuration) || !durations.includes(defaultDuration)) {
    return { ok: false, error: "Default duration must be one of the allowed durations." };
  }
  if (!CONFIGURATION_OBJECTIVES.includes(raw.primaryObjective as (typeof CONFIGURATION_OBJECTIVES)[number])) {
    return { ok: false, error: "Choose a valid optimization objective." };
  }
  if (!raw.inPersonAllowed && !raw.telehealthAllowed) {
    return { ok: false, error: "Allow at least one delivery mode: in person or telehealth." };
  }
  const resourceIds = [...new Set(raw.resourceIds.map((id) => id.trim()).filter(Boolean))];
  if (resourceIds.some((id) => !isUuid(id))) {
    return { ok: false, error: "One or more selected resources are invalid." };
  }

  return {
    ok: true,
    value: {
      name: name.value,
      code,
      department: department.value,
      durations,
      defaultDuration,
      primaryObjective: raw.primaryObjective as (typeof CONFIGURATION_OBJECTIVES)[number],
      requiresAuthorization: raw.requiresAuthorization,
      inPersonAllowed: raw.inPersonAllowed,
      telehealthAllowed: raw.telehealthAllowed,
      groupAllowed: raw.groupAllowed,
      active: raw.active,
      resourceIds,
    },
  };
}
