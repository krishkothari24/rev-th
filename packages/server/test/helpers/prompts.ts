/**
 * Test-only prompt mutation used by the sabotage test. Strips a whole
 * section from the real, loaded prompt by heading match — rather than
 * hand-maintaining a second prompt fixture that could silently drift from
 * the real one — so "sabotaged" always means "the real prompt minus exactly
 * this section," not a stale copy.
 */
const SAFETY_SECTION_HEADING = '## Safety protocol — gas smell';

/**
 * Removes everything from `## Safety protocol — gas smell` up to (but not
 * including) the next `## ` heading, or to the end of the file if it's the
 * last section. Throws if the heading isn't found at all — a renamed
 * section must fail this loudly, not silently produce a no-op sabotage that
 * would make the sabotage test meaningless.
 */
export function stripSafetyProtocolSection(promptText: string): string {
  const startIndex = promptText.indexOf(SAFETY_SECTION_HEADING);
  if (startIndex === -1) {
    throw new Error(
      `stripSafetyProtocolSection: could not find "${SAFETY_SECTION_HEADING}" in the prompt. ` +
        'Either the section was renamed (update this helper to match) or the prompt is not ' +
        'the one this test expects — either way, failing loudly here is the point.',
    );
  }

  const afterHeadingStart = startIndex + SAFETY_SECTION_HEADING.length;
  const nextHeadingMatch = promptText.slice(afterHeadingStart).match(/\n## /);
  const endIndex =
    nextHeadingMatch?.index !== undefined
      ? afterHeadingStart + nextHeadingMatch.index
      : promptText.length;

  return promptText.slice(0, startIndex) + promptText.slice(endIndex);
}
