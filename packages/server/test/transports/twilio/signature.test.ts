import { describe, expect, it } from 'vitest';
import Twilio from 'twilio';
import { verifyTwilioSignature } from '../../../src/transports/twilio/signature.js';

const authToken = 'test-auth-token';
const url = 'http://localhost:3100/webhooks/twilio-sms';
const params = { From: '+17705550100', Body: 'hello' };

function sign(overrideParams: Record<string, string> = params): string {
  return Twilio.getExpectedTwilioSignature(authToken, url, overrideParams);
}

describe('verifyTwilioSignature', () => {
  it('accepts a validly signed request', () => {
    expect(
      verifyTwilioSignature({ authToken, signatureHeader: sign(), url, params }),
    ).toBe(true);
  });

  it('rejects a tampered body param', () => {
    const signatureHeader = sign(params); // signed over the original Body
    const tamperedParams = { ...params, Body: 'STOP' };
    expect(
      verifyTwilioSignature({ authToken, signatureHeader, url, params: tamperedParams }),
    ).toBe(false);
  });

  it('rejects when the auth token used to verify differs from the one used to sign', () => {
    const signatureHeader = Twilio.getExpectedTwilioSignature('a-different-token', url, params);
    expect(verifyTwilioSignature({ authToken, signatureHeader, url, params })).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(
      verifyTwilioSignature({ authToken, signatureHeader: undefined, url, params }),
    ).toBe(false);
  });
});
