// throttle.mjs — Per-provider min-interval throttle for free-tier API calls.
//
// Free-tier limits (per I-2 audit finding + model_dispatcher_research_2.md):
//   - Gemini 2.5 Pro free: ~10 RPM → 12s safe interval with margin
//   - Codestral free:      2 RPM   → 30s required
//   - Mistral Large free:  5 RPM   → 12s would suffice, but we bucket all
//     mistral-SDK calls at 30s for simplicity (docs-gen and codegen both use
//     the same mistral client; over-throttling mistral-large is negligible
//     because docs-gen is called at most once per dispatch run).
//
// Usage: `await throttleFor("gemini")` or `await throttleFor("mistral")`
// immediately before an API call. The module tracks the last call time per
// bucket process-wide; within a single dispatch run (fresh node process each
// 20-min firing) there's typically <5 total calls so the state is simple.

const MIN_INTERVAL_MS = {
  gemini: 12_000,
  mistral: 30_000,
};

const lastCallAt = {
  gemini: 0,
  mistral: 0,
};

/**
 * Wait if needed so that calls to the given provider are spaced out.
 * @param {"gemini"|"mistral"} provider
 */
export async function throttleFor(provider) {
  const minInterval = MIN_INTERVAL_MS[provider];
  if (!minInterval) return;
  const now = Date.now();
  const elapsed = now - lastCallAt[provider];
  if (elapsed < minInterval) {
    const wait = minInterval - elapsed;
    console.log(`[throttle] ${provider} waiting ${wait}ms before next call`);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastCallAt[provider] = Date.now();
}

/**
 * Return the throttle bucket for a model name.
 * @param {string} model
 * @returns {"gemini"|"mistral"}
 */
export function familyFor(model) {
  return model.startsWith("gemini") ? "gemini" : "mistral";
}
