/**
 * Real model provider — wraps `client.messages.create()`/`.stream()` on
 * `config.MODEL_VOICE` (Claude Sonnet 5) or `config.MODEL_FAST` (SMS). No
 * `thinking`/sampling params are set: Sonnet 5 runs adaptive thinking by
 * default and rejects `temperature`/`top_p`/`top_k` outright.
 *
 * Streaming (IMPLEMENTATION_PLAN Phase 8): `send()` only opens a real SSE
 * stream when a caller passes `onTextDelta` — the Retell WS transport is the
 * only caller that does, since it needs to forward text as it's generated
 * rather than wait for the whole turn. Every other caller (SMS, the sim, the
 * eval harness, every existing test) omits it and gets the original
 * non-streaming `create()` call, byte-for-byte unchanged. `stream.on('text',
 * ...)` fires only for text-content-block deltas — the SDK's own
 * `inputJson`/`thinking` events are distinct and never routed here, so a
 * tool call's JSON arguments can never leak into a spoken/texted delta.
 *
 * Translates between this file's Anthropic-shaped-but-independent
 * `ContentBlock` union (agent/types.ts) and the real SDK types, so
 * `ScriptedProvider` never needs to depend on `@anthropic-ai/sdk` at all.
 * `thinking` response blocks are deliberately dropped rather than echoed
 * back on the next round — acceptable for a demo-scale conversation; worth
 * revisiting only if a future phase leans on extended-thinking continuity
 * across turns.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentProvider,
  ContentBlock,
  OnAssistantTextDelta,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderStopReason,
} from '../types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
}

const MAX_TOKENS = 1024;

// Observability, not correctness (IMPLEMENTATION_PLAN's own "Risks" section:
// "Custom LLM means our loop sits in the critical path... a slow
// check_availability is audible dead air"). These thresholds are Retell's
// own first-token target (BUILD_GUIDE §10, ~600-800ms) and a generous total-
// turn budget; crossing either doesn't change behavior, it just leaves a
// `[latency]` line to grep for once real calls are landing in Phase 9/10.
// Deliberately console-based, matching the rest of the codebase's
// non-request-scoped logging (sms/outboundSubscriber.ts, sms/sender.ts) —
// see docs/SCOPE_DECISIONS.md on why this doesn't reach for a metrics stack.
const SLOW_FIRST_TOKEN_MS = 800;
const SLOW_TURN_MS = 4000;

export class AnthropicProvider implements AgentProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async send(request: ProviderRequest, onTextDelta?: OnAssistantTextDelta): Promise<ProviderResponse> {
    const params = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: request.systemPrompt,
      messages: request.messages.map(toAnthropicMessage),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
      })),
    };
    const startedAt = Date.now();

    if (!onTextDelta) {
      const response = await this.client.messages.create(params);
      const totalMs = Date.now() - startedAt;
      if (totalMs > SLOW_TURN_MS) {
        console.warn(`[latency] slow model turn: ${totalMs}ms (model=${this.model}, streaming=false)`);
      }
      return toProviderResponse(response);
    }

    const stream = this.client.messages.stream(params);
    let firstTokenAt: number | null = null;
    stream.on('text', (delta) => {
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        const firstTokenMs = firstTokenAt - startedAt;
        if (firstTokenMs > SLOW_FIRST_TOKEN_MS) {
          console.warn(`[latency] slow first token: ${firstTokenMs}ms (model=${this.model})`);
        }
      }
      onTextDelta(delta);
    });
    const finalMessage = await stream.finalMessage();
    const totalMs = Date.now() - startedAt;
    if (totalMs > SLOW_TURN_MS) {
      console.warn(`[latency] slow model turn: ${totalMs}ms (model=${this.model}, streaming=true)`);
    }
    return toProviderResponse(finalMessage);
  }
}

function toProviderResponse(message: Anthropic.Message): ProviderResponse {
  return {
    content: message.content.map(fromAnthropicBlock).filter((b): b is ContentBlock => b !== null),
    stopReason: toProviderStopReason(message.stop_reason),
  };
}

function toAnthropicMessage(message: ProviderMessage): Anthropic.MessageParam {
  return { role: message.role, content: message.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      };
    default:
      return block satisfies never;
  }
}

/**
 * Returns `null` for anything outside this loop's content model (thinking,
 * server-tool blocks, etc.) rather than throwing or inserting a placeholder
 * — those are filtered out in `send()`, not sent back to the model.
 */
function fromAnthropicBlock(block: Anthropic.ContentBlock): ContentBlock | null {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    };
  }
  return null;
}

function toProviderStopReason(stopReason: Anthropic.Message['stop_reason']): ProviderStopReason {
  if (stopReason === 'tool_use') return 'tool_use';
  if (stopReason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}
