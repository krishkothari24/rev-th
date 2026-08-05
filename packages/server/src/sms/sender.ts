/**
 * Outbound SMS behind an interface (BUILD_GUIDE §7: "Outbound SMS behind a
 * SmsSender interface with a console implementation, so the whole SMS flow
 * is testable with no Twilio account.") IMPLEMENTATION_PLAN Phase 8.
 */
import Twilio from 'twilio';
import { config } from '../config.js';
import { redactPhone, scrubFreeText } from '../lib/redact.js';

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/** Default when no Twilio credentials are configured (Phases 0-8 — no
 * account exists yet). Logs the message with the same PII redaction the rest
 * of the codebase uses, so the whole outbound flow is exercisable and
 * demoable without ever touching a real phone. */
export class ConsoleSmsSender implements SmsSender {
  async send(message: SmsMessage): Promise<void> {
    console.log(`[sms] -> ${redactPhone(message.to)}: ${scrubFreeText(message.body)}`);
  }
}

export interface TwilioSmsSenderOptions {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export class TwilioSmsSender implements SmsSender {
  private readonly client: ReturnType<typeof Twilio>;
  private readonly fromNumber: string;

  constructor(opts: TwilioSmsSenderOptions) {
    this.client = Twilio(opts.accountSid, opts.authToken);
    this.fromNumber = opts.fromNumber;
  }

  async send(message: SmsMessage): Promise<void> {
    await this.client.messages.create({
      to: message.to,
      from: this.fromNumber,
      body: message.body,
    });
  }
}

/** Real credentials in `config` -> real Twilio send; otherwise the console
 * stand-in. This is the one place that decision is made — everything else
 * (the outbound subscriber, tests) just holds an `SmsSender`. */
export function resolveSmsSender(): SmsSender {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = config;
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
    return new TwilioSmsSender({
      accountSid: TWILIO_ACCOUNT_SID,
      authToken: TWILIO_AUTH_TOKEN,
      fromNumber: TWILIO_PHONE_NUMBER,
    });
  }
  return new ConsoleSmsSender();
}
