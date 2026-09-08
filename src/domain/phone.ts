/**
 * E.164 handling. Shortline never repairs or guesses a number; it either
 * validates the canonical form or refuses it.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

export function assertE164(value: string, label = "phone"): string {
  if (!isE164(value)) {
    throw new Error(`${label} must be canonical E.164 (for example +14155550123); got ${maskPhone(value)}`);
  }
  return value;
}

/**
 * NANP numbers in the 555-01XX block are reserved for fiction. Shortline's
 * fixtures use them exclusively, and live mode refuses to dial them so a
 * half-configured deployment fails loudly instead of ringing a stranger.
 */
export function isFictionReserved(phone: string): boolean {
  return /^\+1\d{3}55501\d{2}$/.test(phone);
}

/** `+14155550123` -> `+1 415 ••• 0123`. Safe for logs, UI, and transcripts. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) {
    return "•••";
  }
  const last = digits.slice(-4);
  if (phone.startsWith("+1") && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ••• ${last}`;
  }
  const cc = digits.slice(0, 2);
  return `+${cc} ••• ${last}`;
}

/** Recursively mask any string that looks like an E.164 number inside an object. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\+[1-9]\d{6,14}/g, (m) => maskPhone(m)) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskDeep(v);
    }
    return out as T;
  }
  return value;
}
