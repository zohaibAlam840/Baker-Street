"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { can, type Permission } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import {
  isUuid,
  parseLocationConfiguration,
  parseResourceConfiguration,
  parseServiceConfiguration,
} from "@/lib/configuration/validation";
import { isSupabaseConfigured } from "@/lib/data/snapshot";
import { createClient } from "@/lib/supabase/server";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const checked = (form: FormData, key: string) => form.get(key) === "on";

const fail = (path: string, message: string): never =>
  redirect(`${path}?error=${encodeURIComponent(message)}`);

const done = (path: string, message: string): never =>
  redirect(`${path}?notice=${encodeURIComponent(message)}`);

async function authorizedConfiguration(path: string, permission: Permission) {
  const session = await requireSession();
  if (session.role !== "ADMIN" || !can(session.role, permission)) {
    fail("/no-access", "Only a system administrator can commit configuration changes.");
  }
  if (!isSupabaseConfigured()) {
    fail(path, "Configuration cannot be saved while the application is using synthetic data.");
  }
  return createClient();
}

function configurationError(message: string, code?: string): string {
  if (code === "23505") return "That code or configuration value is already in use.";
  if (message.includes("future appointments")) return message;
  if (message.includes("valid IANA timezone")) return message;
  if (message.includes("not found")) return "This configuration record no longer exists.";
  if (message.includes("System administrator access required")) {
    return "Only a system administrator can commit configuration changes.";
  }
  return message;
}

function configurationSaved(path: string, message: string): never {
  revalidatePath("/configuration");
  revalidatePath(path);
  revalidatePath("/schedule");
  revalidatePath("/book");
  revalidatePath("/optimize");
  return done(path, message);
}

export async function updateLocationConfiguration(form: FormData) {
  const locationId = value(form, "location_id");
  const path = isUuid(locationId) ? `/configuration/locations/${locationId}` : "/configuration";
  if (!isUuid(locationId)) fail(path, "The location identifier is invalid.");
  const parsed = parseLocationConfiguration({
    name: value(form, "name"),
    type: value(form, "type"),
    city: value(form, "city"),
    state: value(form, "state"),
    timezone: value(form, "timezone"),
    active: checked(form, "active"),
  });
  if (!parsed.ok) return fail(path, parsed.error);

  const supabase = await authorizedConfiguration(path, "config.resources");
  const { error } = await supabase.rpc("update_location_configuration", {
    p_location_id: locationId,
    p_name: parsed.value.name,
    p_type: parsed.value.type,
    p_city: parsed.value.city,
    p_state: parsed.value.state,
    p_timezone: parsed.value.timezone,
    p_active: parsed.value.active,
  });
  if (error) fail(path, configurationError(error.message, error.code));
  return configurationSaved(path, "Location configuration saved and audited.");
}

export async function updateResourceConfiguration(form: FormData) {
  const resourceId = value(form, "resource_id");
  const path = isUuid(resourceId) ? `/configuration/resources/${resourceId}` : "/configuration";
  if (!isUuid(resourceId)) fail(path, "The resource identifier is invalid.");
  const parsed = parseResourceConfiguration({
    name: value(form, "name"),
    resourceType: value(form, "resource_type"),
    capacity: value(form, "capacity"),
    locationId: value(form, "location_id"),
    active: checked(form, "active"),
  });
  if (!parsed.ok) return fail(path, parsed.error);

  const supabase = await authorizedConfiguration(path, "config.resources");
  const { error } = await supabase.rpc("update_resource_configuration", {
    p_resource_id: resourceId,
    p_name: parsed.value.name,
    p_resource_type: parsed.value.resourceType,
    p_capacity: parsed.value.capacity,
    p_location_id: parsed.value.locationId,
    p_active: parsed.value.active,
  });
  if (error) fail(path, configurationError(error.message, error.code));
  return configurationSaved(path, "Resource configuration saved and audited.");
}

export async function updateServiceConfiguration(form: FormData) {
  const serviceId = value(form, "service_id");
  const path = isUuid(serviceId) ? `/configuration/services/${serviceId}` : "/configuration";
  if (!isUuid(serviceId)) fail(path, "The service identifier is invalid.");
  const parsed = parseServiceConfiguration({
    name: value(form, "name"),
    code: value(form, "code"),
    department: value(form, "department"),
    durations: value(form, "durations"),
    defaultDuration: value(form, "default_duration"),
    primaryObjective: value(form, "primary_objective"),
    requiresAuthorization: checked(form, "requires_authorization"),
    inPersonAllowed: checked(form, "in_person_allowed"),
    telehealthAllowed: checked(form, "telehealth_allowed"),
    groupAllowed: checked(form, "group_allowed"),
    active: checked(form, "active"),
    resourceIds: form.getAll("resource_ids").map(String),
  });
  if (!parsed.ok) return fail(path, parsed.error);

  const supabase = await authorizedConfiguration(path, "config.services");
  const { error } = await supabase.rpc("update_service_configuration", {
    p_service_id: serviceId,
    p_name: parsed.value.name,
    p_code: parsed.value.code,
    p_department: parsed.value.department,
    p_durations: parsed.value.durations,
    p_default_duration: parsed.value.defaultDuration,
    p_primary_objective: parsed.value.primaryObjective,
    p_requires_authorization: parsed.value.requiresAuthorization,
    p_in_person_allowed: parsed.value.inPersonAllowed,
    p_telehealth_allowed: parsed.value.telehealthAllowed,
    p_group_allowed: parsed.value.groupAllowed,
    p_active: parsed.value.active,
    p_resource_ids: parsed.value.resourceIds,
  });
  if (error) fail(path, configurationError(error.message, error.code));
  return configurationSaved(path, "Service configuration saved atomically and audited.");
}
