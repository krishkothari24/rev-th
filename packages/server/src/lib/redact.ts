/**
 * PII redaction for application logs (BUILD_GUIDE §8.4).
 *
 * Names, phone numbers, addresses, and health details are PII. Full transcripts
 * live in Postgres, never in stdout and never in a third-party log aggregator.
 * Everything logged about a conversation is keyed by conversation ID; the
 * contents stay in the database.
 */

/** `+14045551234` -> `+1404•••1234`. Enough to correlate, not enough to dial. */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return '(none)';
  const trimmed = phone.trim();
  if (trimmed.length <= 6) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}•••${trimmed.slice(-4)}`;
}

/** `1420 Oak Ridge Rd` -> `1•••• O••• R•••• R•`. Shape survives, content doesn't. */
export function redactAddress(address: string | null | undefined): string {
  if (!address) return '(none)';
  return address
    .split(/\s+/)
    .map((word) => (word.length <= 1 ? word : `${word[0]}${'•'.repeat(word.length - 1)}`))
    .join(' ');
}

/** `Maria Delgado` -> `Maria D.` — usable in a log line, not a full identity. */
export function redactName(name: string | null | undefined): string {
  if (!name) return '(none)';
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ?? '';
  if (parts.length === 1) return first;
  return `${first} ${(parts[parts.length - 1] ?? '').charAt(0)}.`;
}

const PHONE_PATTERN = /(\+?\d[\d\s().-]{7,}\d)/g;

/**
 * Last-resort scrub for strings that may contain caller-supplied text. Prefer
 * logging structured fields through the helpers above — this exists so an
 * accidental free-text log doesn't leak a phone number.
 */
export function scrubFreeText(text: string): string {
  return text.replace(PHONE_PATTERN, (match) => redactPhone(match.replace(/[\s().-]/g, '')));
}
