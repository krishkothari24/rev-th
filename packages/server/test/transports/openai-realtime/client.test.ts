/**
 * Unit coverage for `acceptRealtimeCall`'s actual HTTP request body —
 * `webhook.test.ts` injects `acceptCall` as a `vi.fn()` and never exercises
 * the real `fetch()` call this file makes, so nothing previously asserted on
 * the wire shape sent to OpenAI. Added alongside the `turn_detection` fix
 * (choppy-turn-taking root cause) so a future accidental regression of the
 * nesting — same failure mode as the `voice`-at-top-level bug this file's
 * docblock already documents — fails a test instead of silently 200ing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptRealtimeCall } from '../../../src/transports/openai-realtime/client.js';

describe('acceptRealtimeCall', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('nests turn_detection under audio.input alongside transcription, and voice under audio.output', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await acceptRealtimeCall(
      'call-1',
      {
        model: 'gpt-realtime',
        voice: 'marin',
        instructions: 'be nice',
        tools: [],
        transcribeModel: 'gpt-live-transcribe',
        vadEagerness: 'auto',
      },
      { apiKey: 'test-key', apiBaseUrl: 'https://example.test' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      audio: {
        input: {
          transcription: { model: string };
          turn_detection: {
            type: string;
            eagerness: string;
            create_response: boolean;
            interrupt_response: boolean;
          };
        };
        output: { voice: string };
      };
    };

    expect(body.audio.input.transcription.model).toBe('gpt-live-transcribe');
    expect(body.audio.input.turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'auto',
      create_response: true,
      interrupt_response: true,
    });
    expect(body.audio.output.voice).toBe('marin');
  });
});
