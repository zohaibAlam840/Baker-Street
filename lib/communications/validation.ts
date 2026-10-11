export const COMMUNICATION_CHANNELS = ["SMS", "EMAIL", "PUSH"] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export function isCommunicationChannel(value: string): value is CommunicationChannel {
  return COMMUNICATION_CHANNELS.includes(value as CommunicationChannel);
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizePhone(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  const digits = compact.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function normalizeClock(value: string): string | null {
  const clock = value.trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock) ? clock : null;
}

export function validQuietHours(start: string, end: string): boolean {
  const normalizedStart = normalizeClock(start);
  const normalizedEnd = normalizeClock(end);
  return normalizedStart !== null && normalizedEnd !== null && normalizedStart !== normalizedEnd;
}

export function isIanaTimeZone(value: string): boolean {
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function normalizeLanguageTag(value: string): string | null {
  const tag = value.trim();
  if (!tag || tag.length > 35) return null;
  try {
    return new Intl.Locale(tag).toString();
  } catch {
    return null;
  }
}
