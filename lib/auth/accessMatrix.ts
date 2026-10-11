import type { Role } from "./roles";

export type ScopeRelation = "self" | "team" | "unrelated";

export function mayReadPatient(role: Role, relation: ScopeRelation): boolean {
  if (["SCHEDULER", "AUTHORIZATION", "OPERATIONS"].includes(role)) return true;
  return (role === "CLINICAL" || role === "PROVIDER") && relation === "team";
}

export function mayReadProvider(role: Role, relation: ScopeRelation): boolean {
  if (["SCHEDULER", "CLINICAL", "OPERATIONS", "ADMIN"].includes(role)) return true;
  return role === "PROVIDER" && relation === "self";
}

export function mayReadAudit(role: Role): boolean {
  return ["CLINICAL", "OPERATIONS", "ADMIN", "COMPLIANCE"].includes(role);
}

export function mayManageAppointments(role: Role): boolean {
  return role === "SCHEDULER" || role === "CLINICAL";
}

export function mayManageClinicalRequirements(role: Role): boolean { return role === "CLINICAL"; }
export function mayManageAuthorizations(role: Role): boolean { return role === "AUTHORIZATION"; }
export function mayManageConfiguration(role: Role): boolean { return role === "ADMIN"; }
