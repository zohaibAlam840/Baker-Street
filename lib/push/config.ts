export class PushDeliveryConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PushDeliveryConfigurationError";
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

export interface PushDeliveryConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  batchSize: number;
  concurrency: number;
  workerId: string;
}

function present(value: string | undefined) {
  return value?.trim() || null;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
) {
  if (!present(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PushDeliveryConfigurationError(
      code,
      `Push delivery value must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

export function readPushDeliveryConfig(
  env: Environment = process.env,
): PushDeliveryConfig {
  const publicKey = present(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const privateKey = present(env.VAPID_PRIVATE_KEY);
  const subject = present(env.VAPID_SUBJECT);
  if (!publicKey || !privateKey || !subject) {
    throw new PushDeliveryConfigurationError(
      "PUSH_NOT_CONFIGURED",
      "VAPID push delivery is not configured.",
    );
  }
  if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject) && !/^https:\/\//.test(subject)) {
    throw new PushDeliveryConfigurationError(
      "INVALID_VAPID_SUBJECT",
      "VAPID_SUBJECT must be a monitored mailto address or HTTPS URL.",
    );
  }

  const invocation = present(env.VERCEL_REQUEST_ID)
    ?? present(env.GITHUB_RUN_ID)
    ?? crypto.randomUUID();
  return {
    publicKey,
    privateKey,
    subject,
    batchSize: boundedInteger(
      env.PUSH_DELIVERY_BATCH_SIZE,
      50,
      1,
      100,
      "INVALID_PUSH_BATCH_SIZE",
    ),
    concurrency: boundedInteger(
      env.PUSH_DELIVERY_CONCURRENCY,
      5,
      1,
      10,
      "INVALID_PUSH_CONCURRENCY",
    ),
    workerId: `push-${invocation}`.slice(0, 100),
  };
}
