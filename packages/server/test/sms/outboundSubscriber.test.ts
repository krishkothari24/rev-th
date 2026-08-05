import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { eventBus } from '../../src/events/bus.js';
import { registerSmsOutboundSubscriber } from '../../src/sms/outboundSubscriber.js';
import { setDnc } from '../../src/sms/dnc.js';
import type { SmsMessage, SmsSender } from '../../src/sms/sender.js';
import { resetDb } from '../helpers/db.js';

function fakeSender(): { sender: SmsSender; sent: SmsMessage[] } {
  const sent: SmsMessage[] = [];
  return {
    sender: {
      send: async (m: SmsMessage) => {
        sent.push(m);
      },
    },
    sent,
  };
}

// registerSmsOutboundSubscriber's handler runs fire-and-forget (`void
// handle(...)`) and does a real DB round-trip (isDnc) before sending — give
// it a real macrotask turn, not just a microtask, before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('registerSmsOutboundSubscriber', () => {
  let unsubscribe: () => void;
  const originalDispatcherNumber = config.DISPATCHER_ALERT_NUMBER;

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    unsubscribe?.();
    config.DISPATCHER_ALERT_NUMBER = originalDispatcherNumber;
    vi.restoreAllMocks();
  });

  it('sends a booking_confirmation to a non-DNC number', async () => {
    const { sender, sent } = fakeSender();
    unsubscribe = registerSmsOutboundSubscriber(sender);

    eventBus.publish({
      type: 'sms.queued',
      kind: 'booking_confirmation',
      to: '+17705550111',
      body: "you're booked",
    });
    await flush();

    expect(sent).toEqual([{ to: '+17705550111', body: "you're booked" }]);
  });

  it('suppresses booking_confirmation and safety_followup for a DNC number', async () => {
    await setDnc('+17705550122');
    const { sender, sent } = fakeSender();
    unsubscribe = registerSmsOutboundSubscriber(sender);

    eventBus.publish({
      type: 'sms.queued',
      kind: 'booking_confirmation',
      to: '+17705550122',
      body: "you're booked",
    });
    eventBus.publish({
      type: 'sms.queued',
      kind: 'safety_followup',
      to: '+17705550122',
      body: 'stay safe',
    });
    await flush();

    expect(sent).toEqual([]);
  });

  it('sends dispatcher_alert to DISPATCHER_ALERT_NUMBER regardless of the event to field or DNC', async () => {
    config.DISPATCHER_ALERT_NUMBER = '+17705559000';
    await setDnc('(dispatcher)'); // even if this literal placeholder were somehow DNC'd, it must not matter
    const { sender, sent } = fakeSender();
    unsubscribe = registerSmsOutboundSubscriber(sender);

    eventBus.publish({
      type: 'sms.queued',
      kind: 'dispatcher_alert',
      to: '(dispatcher)',
      body: 'EMERGENCY',
    });
    await flush();

    expect(sent).toEqual([{ to: '+17705559000', body: 'EMERGENCY' }]);
  });

  it('drops dispatcher_alert without throwing when DISPATCHER_ALERT_NUMBER is unset', async () => {
    config.DISPATCHER_ALERT_NUMBER = undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sender, sent } = fakeSender();
    unsubscribe = registerSmsOutboundSubscriber(sender);

    eventBus.publish({
      type: 'sms.queued',
      kind: 'dispatcher_alert',
      to: '(dispatcher)',
      body: 'EMERGENCY',
    });
    await flush();

    expect(sent).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ignores non-sms.queued events', async () => {
    const { sender, sent } = fakeSender();
    unsubscribe = registerSmsOutboundSubscriber(sender);

    eventBus.publish({ type: 'call.started', callId: 'x', channel: 'sms', callerPhone: '+1' });
    await flush();

    expect(sent).toEqual([]);
  });
});
