export interface EnterpriseSsoConfig {
  label: string;
  providerId?: string;
  domain?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

export class EnterpriseSsoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnterpriseSsoConfigurationError";
  }
}

const value = (env: Environment, name: string) => env[name]?.trim() ?? "";

export function readEnterpriseSsoConfig(
  env: Environment = process.env,
): EnterpriseSsoConfig | null {
  const enabled = value(env, "ENTERPRISE_SSO_ENABLED").toLowerCase();
  if (!enabled || enabled === "false") return null;
  if (enabled !== "true") {
    throw new EnterpriseSsoConfigurationError("ENTERPRISE_SSO_ENABLED must be true or false.");
  }
  const providerId = value(env, "ENTERPRISE_SSO_PROVIDER_ID");
  const domain = value(env, "ENTERPRISE_SSO_DOMAIN").toLowerCase();
  if (Boolean(providerId) === Boolean(domain)) {
    throw new EnterpriseSsoConfigurationError(
      "Configure exactly one ENTERPRISE_SSO_PROVIDER_ID or ENTERPRISE_SSO_DOMAIN.",
    );
  }
  if (providerId && !/^[A-Za-z0-9_-]{8,160}$/.test(providerId)) {
    throw new EnterpriseSsoConfigurationError("ENTERPRISE_SSO_PROVIDER_ID has an invalid format.");
  }
  if (domain && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))) {
    throw new EnterpriseSsoConfigurationError("ENTERPRISE_SSO_DOMAIN must be a valid DNS domain.");
  }
  const label = value(env, "ENTERPRISE_SSO_LABEL") || "Work SSO";
  if (label.length > 60 || /[\r\n\t]/.test(label)) {
    throw new EnterpriseSsoConfigurationError("ENTERPRISE_SSO_LABEL must contain at most 60 plain-text characters.");
  }
  return {
    label,
    ...(providerId ? { providerId } : { domain }),
  };
}
