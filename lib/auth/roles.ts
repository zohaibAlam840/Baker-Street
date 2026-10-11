/**
 * Roles and permissions.
 *
 * This is the code form of docs/ROLES_AND_PERMISSIONS.md — the proposal the
 * client still has to confirm. The permission names come from the nineteen
 * operations the specification defines, not from an assumed org chart.
 *
 * Keep this file as the single source of truth. A screen that decides what to
 * show by checking the role name directly ("if role === ADMIN") will drift the
 * moment the client corrects the model; screens ask `can(role, permission)`.
 */

export const ROLES = [
  "SCHEDULER",
  "CLINICAL",
  "PROVIDER",
  "AUTHORIZATION",
  "OPERATIONS",
  "ADMIN",
  "COMPLIANCE",
] as const;

export type Role = (typeof ROLES)[number];

export type Permission =
  // Viewing
  | "view.patient_schedule"
  | "view.provider_schedule"
  // Day-to-day scheduling
  | "schedule.check_conflict"
  | "schedule.search_availability"
  | "schedule.book"
  | "schedule.optimize"
  | "schedule.approve"
  /** Approving a change that cuts hours below target or drops a required service. */
  | "schedule.approve_reduction"
  | "schedule.reject"
  | "schedule.override"
  // Clinical and payer data — deliberately held by different roles
  | "clinical.set_requirements"
  | "authorization.manage"
  | "credentials.manage"
  // Availability
  | "availability.manage"
  | "availability.request"
  // Schedule recovery
  | "recovery.view"
  | "recovery.manage"
  | "recovery.report_own"
  | "recovery.offer"
  // Patient and guardian communications
  | "communications.view"
  | "communications.manage"
  | "communications.queue"
  // Configuration
  | "config.services"
  | "config.resources"
  // Analysis
  | "analytics.capacity"
  | "analytics.whatif"
  // Oversight
  | "audit.read"
  | "users.manage";

/**
 * How much data a role may see. Enforced in the database with row-level
 * security once real authentication exists — an application-layer check alone
 * is not enough to protect PHI (§64, minimum necessary).
 */
export type DataScope = "own" | "caseload" | "department" | "all";

export interface RoleDefinition {
  role: Role;
  label: string;
  /** One line, as it appears on the sign-in screen. */
  summary: string;
  /** What this role is for, in the client's terms. */
  description: string;
  scope: DataScope;
  permissions: readonly Permission[];
  /** Estimated headcount, for the client to correct. */
  headcount: string;
  /** Where this role lands after signing in. */
  home: string;
}

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  SCHEDULER: {
    role: "SCHEDULER",
    label: "Scheduler",
    summary: "Books and moves appointments; runs Fill Service",
    description:
      "The primary daily user. Handles cancellations, callouts and the waitlist, and approves routine schedule changes. Cannot change what a patient clinically needs, and cannot enter authorizations.",
    scope: "all",
    headcount: "3–6",
    home: "/dashboard",
    permissions: [
      "view.patient_schedule",
      "view.provider_schedule",
      "schedule.check_conflict",
      "schedule.search_availability",
      "schedule.book",
      "schedule.optimize",
      "schedule.approve",
      "schedule.reject",
      "schedule.override",
      "availability.manage",
      "recovery.view",
      "recovery.manage",
      "recovery.offer",
      "communications.view",
      "communications.manage",
      "communications.queue",
      "analytics.capacity",
    ],
  },

  CLINICAL: {
    role: "CLINICAL",
    label: "Clinical supervisor",
    summary: "Owns clinical requirements; approves reductions in care",
    description:
      "Sets how many hours a patient needs and which services are mandatory. The only role that may approve a change reducing a patient's hours or dropping a required service.",
    scope: "caseload",
    headcount: "8–15",
    home: "/dashboard",
    permissions: [
      "view.patient_schedule",
      "view.provider_schedule",
      "schedule.check_conflict",
      "schedule.search_availability",
      "schedule.book",
      "schedule.optimize",
      "schedule.approve",
      "schedule.approve_reduction",
      "schedule.reject",
      "schedule.override",
      "recovery.view",
      "recovery.manage",
      "recovery.offer",
      "communications.view",
      "clinical.set_requirements",
      "credentials.manage",
      "analytics.capacity",
      "audit.read",
    ],
  },

  PROVIDER: {
    role: "PROVIDER",
    label: "Therapist / provider",
    summary: "Sees their own week; requests time off",
    description:
      "RBTs, OTs, SLPs and therapists. Sees their own schedule and their own patients only — not colleagues' caseloads. Requests time off rather than setting it.",
    scope: "own",
    headcount: "50–70",
    home: "/dashboard",
    permissions: [
      "view.patient_schedule",
      "view.provider_schedule",
      "schedule.check_conflict",
      "schedule.search_availability",
      "availability.request",
      "recovery.report_own",
    ],
  },

  AUTHORIZATION: {
    role: "AUTHORIZATION",
    label: "Authorization specialist",
    summary: "Owns payer authorizations and renewals",
    description:
      "Maintains authorization numbers, authorized hours and effective dates. Deliberately cannot set clinical requirements — keeping payer limits and clinical need in different hands is what stops one silently becoming the other.",
    scope: "all",
    headcount: "2–4",
    home: "/dashboard",
    permissions: ["view.patient_schedule", "authorization.manage"],
  },

  OPERATIONS: {
    role: "OPERATIONS",
    label: "Operations manager",
    summary: "Capacity, utilization and hiring simulations",
    description:
      "Looks across departments: where capacity sits, what demand goes unfilled, what would change if the organisation hired. Reads widely, changes little.",
    scope: "all",
    headcount: "1–3",
    home: "/dashboard",
    permissions: [
      "view.patient_schedule",
      "view.provider_schedule",
      "schedule.check_conflict",
      "schedule.search_availability",
      "analytics.capacity",
      "analytics.whatif",
      "config.resources",
      "audit.read",
    ],
  },

  ADMIN: {
    role: "ADMIN",
    label: "System administrator",
    summary: "Service configuration, rooms and user accounts",
    description:
      "Configures services, optimization profiles, locations and user accounts. Deliberately holds no scheduling or clinical permissions: an administrator who can quietly re-weight an optimization profile can change every schedule in the building.",
    scope: "all",
    headcount: "1–2",
    home: "/dashboard",
    permissions: [
      "config.services",
      "config.resources",
      "credentials.manage",
      "users.manage",
      "audit.read",
    ],
  },

  COMPLIANCE: {
    role: "COMPLIANCE",
    label: "Compliance officer",
    summary: "Read-only audit oversight",
    description:
      "Reads the audit log and override reasons, and can change nothing. HIPAA oversight needs someone who can see what happened without being able to alter it.",
    scope: "all",
    headcount: "1",
    home: "/dashboard",
    permissions: ["audit.read"],
  },
};

export function can(role: Role | null, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_DEFINITIONS[role].permissions.includes(permission);
}

export function canAny(role: Role | null, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(role, permission));
}

export function isRole(value: string | undefined | null): value is Role {
  return !!value && (ROLES as readonly string[]).includes(value);
}

/** Navigation, filtered by what a role may actually do. */
export interface NavItem {
  href: string;
  label: string;
  /** Short label for the mobile tab bar, where space is tight. */
  short: string;
  /** Shown only if the role holds at least one. Empty = always shown. */
  requires: readonly Permission[];
  description: string;
  icon:
    | "search"
    | "dashboard"
    | "calendar"
    | "users"
    | "stethoscope"
    | "spark"
    | "shield"
    | "clipboard"
    | "chart"
    | "settings";
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    short: "Home",
    // Everyone gets a dashboard; its contents adapt to the role.
    requires: [],
    description: "Today at a glance",
    icon: "dashboard",
  },
  {
    href: "/schedule",
    label: "Schedules",
    short: "Schedule",
    requires: ["view.patient_schedule", "view.provider_schedule"],
    description: "Patient and provider weeks",
    icon: "calendar",
  },
  {
    href: "/recovery",
    label: "Schedule recovery",
    short: "Recovery",
    requires: ["recovery.view", "recovery.report_own"],
    description: "Callouts, cancellations and replacement care",
    icon: "clipboard",
  },
  {
    href: "/communications",
    label: "Communications",
    short: "Messages",
    requires: ["communications.view"],
    description: "Reminder delivery, consent and retries",
    icon: "clipboard",
  },
  {
    href: "/search",
    label: "Search",
    short: "Search",
    requires: ["view.patient_schedule"],
    description: "Patients, clinicians and appointments",
    icon: "search",
  },
  {
    href: "/patients",
    label: "Patients",
    short: "Patients",
    requires: ["view.patient_schedule"],
    description: "Caseload, hours and requirements",
    icon: "users",
  },
  {
    href: "/providers",
    label: "Clinicians",
    short: "Staff",
    requires: ["view.provider_schedule"],
    description: "Availability, credentials and utilization",
    icon: "stethoscope",
  },
  {
    href: "/assistant",
    label: "Assistant",
    short: "Ask",
    requires: ["schedule.search_availability"],
    description: "Ask in plain English; the engine answers",
    icon: "spark",
  },
  {
    href: "/book",
    label: "Find a time",
    short: "Book",
    requires: ["schedule.search_availability"],
    description: "Ranked slots that are already proved legal",
    icon: "calendar",
  },
  {
    href: "/optimize",
    label: "Fill service",
    short: "Fill",
    requires: ["schedule.optimize"],
    description: "Get a patient closer to their target hours",
    icon: "spark",
  },
  {
    href: "/approvals",
    label: "Plan optimizer",
    short: "Plans",
    requires: ["schedule.optimize"],
    description: "Build, compare and safely approve multi-service plans",
    icon: "clipboard",
  },
  {
    href: "/simulate",
    label: "Simulation",
    short: "What-if",
    requires: ["analytics.whatif"],
    description: "What changes if the practice hires",
    icon: "chart",
  },
  {
    href: "/authorizations",
    label: "Authorizations",
    short: "Auth",
    requires: ["authorization.manage"],
    description: "Payer authorizations and renewals",
    icon: "shield",
  },
  {
    href: "/clinical",
    label: "Clinical",
    short: "Clinical",
    requires: ["clinical.set_requirements"],
    description: "Hours each patient needs",
    icon: "clipboard",
  },
  {
    href: "/capacity",
    label: "Capacity",
    short: "Capacity",
    requires: ["analytics.capacity", "analytics.whatif"],
    description: "Utilization and unfilled demand",
    icon: "chart",
  },
  {
    href: "/configuration",
    label: "Configuration",
    short: "Config",
    requires: ["config.services", "users.manage"],
    description: "Services, rooms and users",
    icon: "settings",
  },
  {
    href: "/audit",
    label: "Audit log",
    short: "Audit",
    requires: ["audit.read"],
    description: "Every change, and why",
    icon: "shield",
  },
  {
    href: "/notifications",
    label: "Work queue",
    short: "Tasks",
    requires: [],
    description: "Warnings and follow-up work",
    icon: "clipboard",
  },
  {
    href: "/reports",
    label: "Reports",
    short: "Reports",
    requires: ["analytics.capacity"],
    description: "Care delivery and utilization exports",
    icon: "chart",
  },
  {
    href: "/settings",
    label: "Settings",
    short: "Settings",
    // Everyone has settings; the page adapts to the role.
    requires: [],
    description: "Your account and this environment",
    icon: "settings",
  },
] as const;

export function navFor(role: Role | null): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.requires.length === 0 || canAny(role, item.requires),
  );
}

/**
 * The mobile tab bar holds four destinations plus "More".
 *
 * Five targets is the practical ceiling for a thumb-reachable bar; past that
 * the labels truncate and the targets get too narrow to hit reliably.
 */
export function primaryNavFor(role: Role | null): NavItem[] {
  const preferredHrefs: Record<Role, readonly string[]> = {
    SCHEDULER: ["/dashboard", "/schedule", "/recovery", "/communications"],
    CLINICAL: ["/dashboard", "/schedule", "/recovery", "/patients"],
    PROVIDER: ["/dashboard", "/schedule", "/recovery", "/notifications"],
    AUTHORIZATION: ["/dashboard", "/schedule", "/authorizations", "/notifications"],
    OPERATIONS: ["/dashboard", "/schedule", "/capacity", "/reports"],
    ADMIN: ["/dashboard", "/configuration", "/audit", "/settings"],
    COMPLIANCE: ["/dashboard", "/audit", "/notifications", "/settings"],
  };
  const allowed = new Map(navFor(role).map((item) => [item.href, item]));
  const hrefs = role
    ? preferredHrefs[role]
    : ["/dashboard", "/notifications", "/settings"];

  return hrefs.flatMap((href) => {
    const item = allowed.get(href);
    if (!item) return [];
    if (role === "PROVIDER" && href === "/recovery") {
      return [{ ...item, short: "Report" }];
    }
    return [item];
  });
}
