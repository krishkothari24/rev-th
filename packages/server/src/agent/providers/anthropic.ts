/**
 * Real model provider — wraps one non-streaming `client.messages.create()`
 * call on `config.MODEL_VOICE` (Claude Sonnet 5). Non-streaming is a
 * deliberate Phase 4 choice: there's no telephony audio path yet, so
 * first-token latency doesn't matter the way it will once Retell is in the
 * loop (Phase 8) — a text REPL has no such constraint. No `thinking`/
 * sampling params are set: Sonnet 5 runs adaptive thinking by default and
 * rejects `temperature`/`top_p`/`top_k` outright.
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

export class AnthropicProvider implements AgentProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: request.systemPrompt,
      messages: request.messages.map(toAnthropicMessage),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
      })),
    });

    return {
      content: response.content
        .map(fromAnthropicBlock)
        .filter((b): b is ContentBlock => b !== null),
      stopReason: toProviderStopReason(response.stop_reason),
    };
  }
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
