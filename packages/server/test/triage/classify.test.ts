import { describe, expect, it, vi } from 'vitest';
import { classifyUrgency } from '../../src/triage/classify.js';
import type { HazardCheckProvider } from '../../src/triage/hazardCheck.js';

const BASE = {
  vulnerablePersonPresent: null as boolean | null,
  season: 'shoulder' as const,
  propertyType: 'residential' as const,
};

describe('classifyUrgency — safety override (TEST_SCENARIOS #1, #5)', () => {
  it('fires on a gas-smell cold open', async () => {
    const result = await classifyUrgency({
      ...BASE,
      statedIssue: 'gas smell',
      transcript: 'I smell gas in my kitchen.',
    });
    expect(result.safetyOverride).toMatchObject({
      fired: true,
      reason: 'gas_smell',
      signal: 'keyword',
    });
    expect(result.urgency).toBe('emergency');
  });

  it('fires on a mid-call pivot even though statedIssue disagrees', async () => {
    const result = await classifyUrgency({
      ...BASE,
      statedIssue: 'routine maintenance',
      transcript:
        'Caller: Hi, I need to schedule my annual furnace tune-up.\nCaller: Actually — hang on, I smell something like rotten eggs.',
    });
    expect(result.safetyOverride.fired).toBe(true);
    expect(result.urgency).toBe('emergency');
  });

  it('reads the raw transcript, not a summarized statedIssue', async () => {
    const result = await classifyUrgency({
      ...BASE,
      statedIssue: 'nothing wrong, routine',
      transcript: 'I smell gas',
    });
    expect(result.safetyOverride.fired).toBe(true);
  });
});

describe('classifyUrgency — false positives do not fire the override', () => {
  it('"the gas company called" does not fire', async () => {
    const result = await classifyUrgency({
      ...BASE,
      statedIssue: 'billing question',
      transcript: 'the gas company called about my bill',
    });
    expect(result.safetyOverride).toEqual({ fired: false });
  });

  it('a gas furnace tune-up does not fire the override, but does route to a gas-certified tech', async () => {
    const result = await classifyUrgency({
      ...BASE,
      statedIssue: 'my gas furnace needs a tune-up',
      transcript: 'my gas furnace needs a tune-up',
    });
    expect(result.safetyOverride).toEqual({ fired: false });
    expect(result.requiredSkills).toContain('gas');
  });
});

describe('classifyUrgency — injected hazard-check provider (OR logic + cost gate)', () => {
  function stubProvider(
    hazard: boolean,
  ): HazardCheckProvider & { check: ReturnType<typeof vi.fn> } {
    return { check: vi.fn().mockResolvedValue({ hazard }) };
  }

  it('fires on the LLM signal alone when the keyword layer is silent', async () => {
    const provider = stubProvider(true);
    const result = await classifyUrgency(
      {
        ...BASE,
        statedIssue: 'billing question',
        transcript: 'the gas company called about my bill',
      },
      { hazardCheckProvider: provider },
    );
    expect(result.safetyOverride).toMatchObject({
      fired: true,
      signal: 'llm',
      matchedIndicatorIds: [],
    });
    expect(provider.check).toHaveBeenCalledTimes(1);
  });

  it('reports "both" when keyword and LLM signals agree', async () => {
    const provider = stubProvider(true);
    const result = await classifyUrgency(
      { ...BASE, statedIssue: 'gas smell', transcript: 'I smell gas' },
      { hazardCheckProvider: provider },
    );
    expect(result.safetyOverride).toMatchObject({ fired: true, signal: 'both' });
  });

  it('never invokes the provider when there is no candidate token at all', async () => {
    const provider = stubProvider(true);
    const result = await classifyUrgency(
      { ...BASE, statedIssue: 'no heat', transcript: 'no heat, please help' },
      { hazardCheckProvider: provider },
    );
    expect(provider.check).not.toHaveBeenCalled();
    expect(result.safetyOverride).toEqual({ fired: false });
  });

  it('does not fire when the provider says no', async () => {
    const provider = stubProvider(false);
    const result = await classifyUrgency(
      {
        ...BASE,
        statedIssue: 'billing question',
        transcript: 'the gas company called about my bill',
      },
      { hazardCheckProvider: provider },
    );
    expect(result.safetyOverride).toEqual({ fired: false });
    expect(provider.check).toHaveBeenCalledTimes(1);
  });

  it('defaults to the disabled provider — the model is entirely out of the loop this phase', async () => {
    const result = await classifyUrgency({
      ...BASE,
      statedIssue: 'billing question',
      transcript: 'the gas company called about my bill',
    });
    expect(result.safetyOverride).toEqual({ fired: false });
  });
});

describe('classifyUrgency — urgency matrix (TEST_SCENARIOS #2-4, seed cross-check)', () => {
  it('TEST_SCENARIOS #2: furnace died, elderly occupant, heating season → priority', async () => {
    const result = await classifyUrgency({
      statedIssue: 'no heat',
      transcript: "My furnace died last night, it's my grandmother's house and she's 84.",
      vulnerablePersonPresent: true,
      season: 'heating',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('priority');
    expect(result.safetyOverride.fired).toBe(false);
  });

  it('TEST_SCENARIOS #3: AC out two days, asthma, cooling season → priority + refrigerant_epa', async () => {
    const result = await classifyUrgency({
      statedIssue: 'no AC',
      transcript: "AC's been out two days, my son has asthma.",
      vulnerablePersonPresent: true,
      season: 'cooling',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('priority');
    expect(result.requiredSkills).toContain('refrigerant_epa');
  });

  it('TEST_SCENARIOS #4: furnace out in June, nobody home, no vulnerable person → routine (no over-escalation)', async () => {
    const result = await classifyUrgency({
      statedIssue: 'no heat',
      transcript: "Furnace's out but it's June and nobody's home most of the day.",
      vulnerablePersonPresent: false,
      season: 'cooling',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('routine');
  });

  it('the same off-season total loss, but with a vulnerable person, is rescued to priority', async () => {
    const result = await classifyUrgency({
      statedIssue: 'no heat',
      transcript: "Furnace's out but it's June.",
      vulnerablePersonPresent: true,
      season: 'cooling',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('priority');
  });

  it('a vulnerable person on a routine maintenance call never manufactures urgency', async () => {
    const result = await classifyUrgency({
      statedIssue: 'annual maintenance tune-up',
      transcript: 'Just want to schedule the annual furnace tune-up.',
      vulnerablePersonPresent: true,
      season: 'heating',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('routine');
  });

  it('no heat in shoulder season is still treated as relevant', async () => {
    const result = await classifyUrgency({
      statedIssue: 'no heat',
      transcript: 'We have no heat at all.',
      vulnerablePersonPresent: null,
      season: 'shoulder',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('priority');
  });

  it('short-cycling during a cold snap is priority (matches seed PRIORITY_ISSUES)', async () => {
    const result = await classifyUrgency({
      statedIssue: 'furnace short-cycling',
      transcript: 'The furnace keeps short-cycling during this cold snap.',
      vulnerablePersonPresent: null,
      season: 'heating',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('priority');
  });

  it('AC blowing warm is routine, not a total loss (matches seed ROUTINE_ISSUES)', async () => {
    const result = await classifyUrgency({
      statedIssue: 'AC blowing warm on hot afternoons',
      transcript: 'The AC is blowing warm on hot afternoons, minor issue.',
      vulnerablePersonPresent: null,
      season: 'cooling',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('routine');
  });

  it('"AC not cooling well" is degraded performance, not a total loss', async () => {
    const result = await classifyUrgency({
      statedIssue: "AC's not cooling well",
      transcript: "My AC is not cooling well, it's not cooling well in the afternoons.",
      vulnerablePersonPresent: null,
      season: 'cooling',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('routine');
  });

  it('"furnace is not heating well" is degraded performance, not a total loss', async () => {
    const result = await classifyUrgency({
      statedIssue: 'furnace is not heating well',
      transcript: 'The furnace is not heating well, just a little weak lately.',
      vulnerablePersonPresent: null,
      season: 'heating',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('routine');
  });

  it('"AC is not cooling" (no qualifier) is still a total loss', async () => {
    const result = await classifyUrgency({
      statedIssue: 'AC is not cooling',
      transcript: 'The AC is not cooling at all.',
      vulnerablePersonPresent: null,
      season: 'cooling',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('priority');
  });

  it('total loss of both heat and cooling is always season-relevant', async () => {
    const result = await classifyUrgency({
      statedIssue: 'no heat and no AC',
      transcript: 'Whole system is down — no heat and no AC.',
      vulnerablePersonPresent: null,
      season: 'shoulder',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('priority');
  });

  it('a routine call with no loss-of-conditioning language stays routine', async () => {
    const result = await classifyUrgency({
      statedIssue: 'annual maintenance tune-up',
      transcript: 'Just the annual tune-up please.',
      vulnerablePersonPresent: null,
      season: 'heating',
      propertyType: 'residential',
    });
    expect(result.urgency).toBe('routine');
  });
});

describe('classifyUrgency — contract', () => {
  it('returns a Promise', () => {
    const result = classifyUrgency({
      statedIssue: 'routine',
      transcript: 'annual tune-up',
      vulnerablePersonPresent: null,
      season: 'shoulder',
      propertyType: 'residential',
    });
    expect(result).toBeInstanceOf(Promise);
  });
});
