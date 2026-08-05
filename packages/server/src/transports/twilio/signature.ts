/**
 * Twilio webhook authenticity (BUILD_GUIDE §8.1): `X-Twilio-Signature` is
 * HMAC-SHA1 over the exact webhook URL plus the sorted POST param key/value
 * pairs, keyed by the account's auth token — a different shape from Retell's
 * raw-body HMAC (see transports/retell/signature.ts), so this thinly wraps
 * the `twilio` package's own `validateRequest` rather than hand-rolling it.
 *
 * `url` is always the fixed, configured webhook URL
 * (`${PUBLIC_BASE_URL}/webhooks/twilio-sms`) — never reconstructed from the
 * incoming request. URL-exactness (scheme, host, trailing slash, query
 * encoding) is Twilio signature verification's most common real-world
 * failure mode; a hardcoded known-good URL removes that class of bug
 * entirely rather than relying on `trustProxy` to reconstruct it correctly.
 */
import Twilio from 'twilio';

export interface VerifyTwilioSignatureOptions {
  authToken: string;
  signatureHeader: string | undefined;
  url: string;
  params: Record<string, string>;
}

export function verifyTwilioSignature(opts: VerifyTwilioSignatureOptions): boolean {
  if (!opts.signatureHeader) return false;
  return Twilio.validateRequest(opts.authToken, opts.signatureHeader, opts.url, opts.params);
}
