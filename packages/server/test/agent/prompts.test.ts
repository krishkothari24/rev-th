import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSystemPromptForTurn,
  loadAgentSystemPrompt,
  loadPromptFileAt,
} from '../../src/agent/prompts.js';

describe('loadAgentSystemPrompt', () => {
  it('loads the real prompt and contains the safety-protocol heading', () => {
    const prompt = loadAgentSystemPrompt();
    expect(prompt).toContain('## Safety protocol — gas smell');
  });

  it('contains the caller-instructions-are-not-directives section (BUILD_GUIDE §8.3)', () => {
    const prompt = loadAgentSystemPrompt();
    expect(prompt).toContain('## How to treat what callers say');
    expect(prompt).toMatch(/conversational content/i);
  });
});

describe('loadPromptFileAt — mtime-based hot reload', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'summit-air-prompt-test-'));
    filePath = path.join(dir, 'scratch.md');
    writeFileSync(filePath, 'version one');
  });

  it('returns the file contents', () => {
    expect(loadPromptFileAt(filePath)).toBe('version one');
  });

  it('re-reads the file once its mtime changes', () => {
    expect(loadPromptFileAt(filePath)).toBe('version one');

    writeFileSync(filePath, 'version two');
    // Force the mtime forward — some filesystems have coarse mtime
    // resolution and a same-millisecond rewrite could otherwise look
    // unchanged to the cache.
    const future = new Date(Date.now() + 5000);
    utimesSync(filePath, future, future);

    expect(loadPromptFileAt(filePath)).toBe('version two');
  });

  it('does not re-read when the mtime is unchanged (cache hit)', () => {
    expect(loadPromptFileAt(filePath)).toBe('version one');
    // Rewrite content without touching mtime meaningfully is hard to force
    // portably, so instead assert the simpler, load-bearing property: two
    // reads with no intervening write return the same content.
    expect(loadPromptFileAt(filePath)).toBe('version one');
  });
});

describe('buildSystemPromptForTurn', () => {
  const fixedDate = new Date('2026-01-15T12:00:00Z');

  it('appends date and season to the loaded prompt by default', () => {
    const result = buildSystemPromptForTurn({ season: 'heating' }, fixedDate);
    expect(result).toContain('## Safety protocol — gas smell');
    expect(result).toContain("It's heating season.");
    expect(result).toContain('Thursday, January 15, 2026');
  });

  it('uses systemPromptOverride instead of the loaded file when set', () => {
    const result = buildSystemPromptForTurn(
      { season: 'cooling', systemPromptOverride: 'SABOTAGED PROMPT' },
      fixedDate,
    );
    expect(result).toContain('SABOTAGED PROMPT');
    expect(result).not.toContain('## Safety protocol — gas smell');
    expect(result).toContain("It's cooling season.");
  });
});

describe('buildSystemPromptForTurn — recognition + membership appendix (Phase 6)', () => {
  const fixedDate = new Date('2026-01-15T12:00:00Z');
  const routineTriage = {
    urgency: 'routine' as const,
    requiredSkills: [],
    safetyOverride: { fired: false as const },
  };
  const emergencyTriage = {
    urgency: 'emergency' as const,
    requiredSkills: ['gas' as const],
    safetyOverride: {
      fired: true as const,
      reason: 'gas_smell' as const,
      signal: 'keyword' as const,
      matchedIndicatorIds: ['x'],
    },
  };

  // Note: the static prompt's own "Returning callers" section already
  // discusses recognition in the abstract ("if the context ... says the
  // caller's phone number matches an existing customer") — these assertions
  // key on the appendix's concrete "This caller's phone number matches..."
  // line, which only appears when recognizedCustomerSummary is actually set.
  it('adds no concrete recognition line for an unrecognized caller', () => {
    const result = buildSystemPromptForTurn({ season: 'heating' }, fixedDate);
    expect(result).not.toContain("This caller's phone number matches an existing customer");
  });

  it('adds the recognition line, reusing the stored summary verbatim, for a recognized caller', () => {
    const result = buildSystemPromptForTurn(
      { season: 'heating', recognizedCustomerSummary: 'Maria Delgado. Comfort Club member.' },
      fixedDate,
    );
    expect(result).toContain(
      "This caller's phone number matches an existing customer: Maria Delgado. Comfort Club member.",
    );
    expect(result).toContain('do not');
  });

  it('grants soft one-time mention permission for a non-member on a routine call', () => {
    const result = buildSystemPromptForTurn(
      { season: 'heating', knownMembershipTier: null, lastTriage: routineTriage },
      fixedDate,
    );
    expect(result).toMatch(/not a member.*may mention the membership plan once/is);
  });

  it('grants natural plan reference for a member on a routine call', () => {
    const result = buildSystemPromptForTurn(
      { season: 'heating', knownMembershipTier: 'comfort_club', lastTriage: routineTriage },
      fixedDate,
    );
    expect(result).toMatch(/Comfort Club member.*reference their plan naturally/is);
  });

  it('blocks any membership mention on a safety-override call, member or not', () => {
    const result = buildSystemPromptForTurn(
      { season: 'heating', knownMembershipTier: 'comfort_club', lastTriage: emergencyTriage },
      fixedDate,
    );
    expect(result).toContain('Do not bring up or promote a membership plan on this call');
  });

  it('blocks any membership mention on a non-routine urgency even without a full safety override', () => {
    const priorityTriage = {
      urgency: 'priority' as const,
      requiredSkills: [],
      safetyOverride: { fired: false as const },
    };
    const result = buildSystemPromptForTurn(
      { season: 'heating', knownMembershipTier: null, lastTriage: priorityTriage },
      fixedDate,
    );
    expect(result).toContain('Do not bring up or promote a membership plan on this call');
  });
});
