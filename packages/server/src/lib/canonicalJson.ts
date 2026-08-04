/**
 * Deterministic JSON serialization for hashing (BUILD_GUIDE §2:
 * `idempotency_key = sha256(call_id + tool_name + canonical_json(args))`).
 *
 * `JSON.stringify` preserves insertion order for object keys, so the exact
 * same logical args object can hash differently depending on how the caller
 * happened to construct it. Sorting keys recursively before stringifying
 * makes the hash a function of the value, not of incidental key order.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
