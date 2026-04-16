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
 * Register throttle intervals from provider config.
 * Call once at startup after loading budget.json.
 * @param {object} [providerConfig] - free_model_roster.providers from budget.json
 */
export function initThrottle(providerConfig) {
  for (const [name, cfg] of Object.entries(providerConfig ?? {})) {
    if (cfg.throttle_ms != null) {
      MIN_INTERVAL_MS[name] = cfg.throttle_ms;
      if (!(name in lastCallAt)) lastCallAt[name] = 0;
    }
  }
}

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
 * @deprecated Use providerFor() from provider.mjs for new code.
 * @param {string} model
 * @returns {string}
 */
export function familyFor(model) {
  // Delegate to providerFor logic for backward compat.
  // Inline rather than importing to avoid circular dependency.
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("local/")) return "ollama";
  if (model.startsWith("groq/")) return "groq";
  if (model.startsWith("openrouter/")) return "openrouter";
  return "mistral";
}

/**
 * Wrap a promise with a hard timeout (I-4).
 * Free-tier APIs can hang indefinitely during outages.
 * @param {Promise<T>} promise
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [label] - Label for error message
 * @returns {Promise<T>}
 * @template T
 */
export function withTimeout(promise, ms, label = "API call") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[I-4] ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Default API call timeout: 60 seconds. */
export const API_TIMEOUT_MS = 60_000;
