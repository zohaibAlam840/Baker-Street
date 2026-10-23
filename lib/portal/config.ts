type Environment = Readonly<Record<string, string | undefined>>;

export function guardianPortalEnabled(env: Environment = process.env) {
  const raw = env.GUARDIAN_PORTAL_ENABLED?.trim().toLowerCase() ?? "false";
  if (raw !== "true" && raw !== "false") {
    throw new Error("GUARDIAN_PORTAL_ENABLED must be true or false.");
  }
  return raw === "true";
}
