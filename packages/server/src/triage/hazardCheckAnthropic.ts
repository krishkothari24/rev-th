/**
 * Real hazard-check provider — BUILD_GUIDE §5: "a cheap Haiku call for a
 * yes/no hazard check on any turn containing a candidate token." Implements
 * the `HazardCheckProvider` interface hazardCheck.ts already defines, so
 * classify.ts needs zero changes to accept it — exactly what that file's own
 * docblock says this phase should be able to do. Uses only
 * `input.candidateText` (never the full transcript), per that interface's
 * stated intent: a cheap, targeted prompt, not a resend of the whole call.
 *
 * Uses structured outputs (`output_config.format`, a JSON schema) rather
 * than tool-use: this is a single-shot classification, not an agentic tool
 * call, and structured outputs guarantee the response parses as
 * `{hazard: boolean, rationale?: string}` with no further validation needed.
 * Haiku 4.5 supports structured outputs and needs no `thinking`/`effort`
 * params for a task this small (effort in particular errors on Haiku 4.5).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { HazardCheckInput, HazardCheckProvider, HazardCheckResult } from './hazardCheck.js';

export interface AnthropicHazardCheckProviderOptions {
  apiKey: string;
  model: string;
}

const HAZARD_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    hazard: { type: 'boolean' },
    rationale: { type: 'string' },
  },
  required: ['hazard'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  'You are a safety classifier for an HVAC dispatch phone system. Given a short ' +
  'snippet of caller speech, decide whether it describes an active gas-leak/gas-hazard ' +
  'situation (e.g. smelling gas, rotten eggs, sulfur, a hissing gas line) as opposed to ' +
  'an unrelated mention of "gas" (a gas bill, a gas station, a routine gas furnace ' +
  'tune-up). Respond only with the requested JSON — never speak to the caller.';

export class AnthropicHazardCheckProvider implements HazardCheckProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicHazardCheckProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async check(input: HazardCheckInput): Promise<HazardCheckResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input.candidateText }],
      output_config: { format: { type: 'json_schema', schema: HAZARD_RESULT_SCHEMA } },
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) {
      return { hazard: false, rationale: 'hazard-check model returned no text content' };
    }

    try {
      const parsed = JSON.parse(textBlock.text) as { hazard: boolean; rationale?: string };
      return { hazard: parsed.hazard === true, rationale: parsed.rationale };
    } catch {
      return { hazard: false, rationale: 'hazard-check model response was not valid JSON' };
    }
  }
}
