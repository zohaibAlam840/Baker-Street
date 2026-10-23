export interface CpSatConfig {
  url: string;
  secret: string;
  required: boolean;
  timeoutMs: number;
  maxCandidates: number;
  timeLimitSeconds: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

export class CpSatConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpSatConfigurationError";
  }
}

function value(env: Environment, name: string) {
  return env[name]?.trim() ?? "";
}

function booleanValue(env: Environment, name: string, fallback: boolean) {
  const raw = value(env, name).toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new CpSatConfigurationError(`${name} must be true or false.`);
}

function boundedNumber(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer: boolean,
) {
  const raw = value(env, name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed)) || parsed < minimum || parsed > maximum) {
    throw new CpSatConfigurationError(
      `${name} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function solverOrigin(raw: string, allowLocalHttp: boolean) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CpSatConfigurationError("CP_SAT_SOLVER_URL must be a valid URL.");
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(allowLocalHttp && local && parsed.protocol === "http:")) {
    throw new CpSatConfigurationError(
      "CP_SAT_SOLVER_URL must use HTTPS; local HTTP is permitted only in development.",
    );
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new CpSatConfigurationError(
      "CP_SAT_SOLVER_URL must be an origin with no credentials, path, query, or fragment.",
    );
  }
  return parsed.origin;
}

export function readCpSatConfig(
  env: Environment = process.env,
  options: { allowLocalHttp?: boolean } = {},
): CpSatConfig | null {
  const required = booleanValue(env, "CP_SAT_REQUIRED", false);
  const rawUrl = value(env, "CP_SAT_SOLVER_URL");
  const secret = value(env, "CP_SAT_SOLVER_SECRET");
  if (!rawUrl && !secret && !required) return null;
  if (!rawUrl) throw new CpSatConfigurationError("CP_SAT_SOLVER_URL is required when CP-SAT is configured.");
  if (secret.length < 24) {
    throw new CpSatConfigurationError("CP_SAT_SOLVER_SECRET must contain at least 24 characters.");
  }
  return {
    url: solverOrigin(rawUrl, options.allowLocalHttp ?? process.env.NODE_ENV !== "production"),
    secret,
    required,
    timeoutMs: boundedNumber(env, "CP_SAT_TIMEOUT_MS", 9_000, 500, 30_000, true),
    maxCandidates: boundedNumber(env, "CP_SAT_MAX_CANDIDATES", 4_000, 100, 12_000, true),
    timeLimitSeconds: boundedNumber(env, "CP_SAT_TIME_LIMIT_SECONDS", 8, 0.25, 30, false),
  };
}
