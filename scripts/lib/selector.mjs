// selector.mjs — Phase 2: Project + task selection via Gemini 2.5 Pro.
// Uses ~2-5K free-tier Gemini tokens per run.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@google/genai";
import { buildProjectContext } from "./context.mjs";
import { extractJson } from "./extract-json.mjs";
import { throttleFor } from "./throttle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "..", "..", "status", "budget-dispatch-log.jsonl");

// I-1: Gemini native structured-output schema. When passed as responseSchema
// with responseMimeType "application/json", Gemini guarantees the response
// is valid JSON matching this shape — no extractJson / nudge-retry needed.
const SELECTOR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    project: { type: Type.STRING },
    task: { type: Type.STRING },
    reason: { type: Type.STRING },
  },
  required: ["project", "task", "reason"],
  propertyOrdering: ["project", "task", "reason"],
};

/**
 * Call Gemini to select one project and one task from the rotation.
 * @param {object} config - Parsed budget.json
 * @param {{ gemini: object }} clients - SDK instances
 * @returns {Promise<{ project: string, task: string, reason: string, projectConfig: object }|null>}
 */
export async function selectProjectAndTask(config, clients) {
  const projects = config.projects_in_rotation ?? [];
  const contexts = [];

  for (const proj of projects) {
    const ctx = buildProjectContext(proj, LOG_PATH);
    if (!ctx) {
      console.warn(`[selector] skipping ${proj.slug}: no DISPATCH.md`);
      continue;
    }
    contexts.push({ ...ctx, config: proj });
  }

  if (contexts.length === 0) {
    console.warn("[selector] no eligible projects");
    return null;
  }

  const prompt = buildSelectorPrompt(contexts);
  const model = config.selector_model ?? "gemini-2.5-pro";
  const temperature = config.selector_temperature ?? 0;
  const maxTokens = config.selector_max_tokens ?? 500;

  // I-1: native structured-output mode. responseMimeType + responseSchema
  // guarantee valid JSON, eliminating the prior extractJson + nudge-retry path.
  let responseText;
  try {
    responseText = await callGeminiWithRetry(clients.gemini, model, prompt, {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
      responseSchema: SELECTOR_SCHEMA,
    });
  } catch (e) {
    console.error(`[selector] Gemini call failed: ${e.message}`);
    return null;
  }

  // Native JSON mode output parses directly. Keep extractJson as a last-resort
  // fallback in case the SDK ever delivers fenced / preamble-wrapped text
  // despite the mime-type hint.
  let selection;
  try {
    selection = JSON.parse(responseText);
  } catch {
    try {
      selection = extractJson(responseText);
    } catch (e2) {
      console.error(`[selector] JSON parse failed: ${e2.message}`);
      return null;
    }
  }

  // Validate selection against config
  if (!selection.project || !selection.task) {
    console.error("[selector] response missing project or task field");
    return null;
  }

  const projectConfig = projects.find((p) => p.slug === selection.project);
  if (!projectConfig) {
    console.error(`[selector] unknown project slug: ${selection.project}`);
    return null;
  }

  if (!projectConfig.opportunistic_tasks.includes(selection.task)) {
    console.error(
      `[selector] task "${selection.task}" not in ${selection.project}'s opportunistic_tasks`
    );
    return null;
  }

  return {
    project: selection.project,
    task: selection.task,
    reason: selection.reason ?? "",
    projectConfig,
  };
}

/**
 * Build the constrained selector prompt.
 * @param {object[]} contexts - Project context objects from buildProjectContext
 * @returns {string}
 */
function buildSelectorPrompt(contexts) {
  const projectBlocks = contexts
    .map(
      (ctx) => `### ${ctx.slug}
- Clinical gate: ${ctx.clinical_gate}
- Allowed tasks: ${ctx.opportunistic_tasks.join(", ")}
- Last dispatched: ${ctx.last_dispatched}

**State:**
<data source="STATE.md" project="${ctx.slug}">
${ctx.state_summary}
</data>

**Pre-Approved Tasks:**
<data source="DISPATCH.md" project="${ctx.slug}">
${ctx.approved_tasks}
</data>

**Recent Outcomes (I-3):**
${ctx.recent_outcomes}`
    )
    .join("\n\n---\n\n");

  return `You are the project/task selector for an automated budget dispatcher.

Given these projects and their current state, pick ONE project and ONE task.

## Rules (in priority order)
1. Failing tests or typecheck errors -> highest priority
2. Stale status (oldest last-dispatch timestamp) -> next priority
3. Least-recently-dispatched -> tiebreaker
4. ONLY pick from the intersection of the project's Pre-Approved Tasks and its "Allowed tasks" list
5. Tasks that would touch domain/ on clinical_gate=true projects are FORBIDDEN
6. Avoid tasks that failed or were reverted in the last 2 consecutive attempts — pick a different task or project instead
7. If all projects were recently dispatched and have no urgent issues, pick the one with the most impactful available task

## Projects

${projectBlocks}

## Response format
Respond with EXACTLY this JSON (no markdown fences, no explanation):
{"project": "<slug>", "task": "<task-keyword>", "reason": "<one line explanation>"}`;
}

/**
 * Call Gemini with simple retry (rate limit / 503 handling).
 * @param {object} gemini - GoogleGenAI instance
 * @param {string} model - Model ID
 * @param {string} prompt - Full prompt text
 * @param {object} genConfig - Generation config (temperature, maxOutputTokens)
 * @returns {Promise<string>} Response text
 */
async function callGeminiWithRetry(gemini, model, prompt, genConfig) {
  const delays = [2000, 4000, 8000];
  let lastError;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await throttleFor("gemini"); // I-2: free-tier rate limit
      const response = await gemini.models.generateContent({
        model,
        contents: prompt,
        config: genConfig,
      });
      return response.text;
    } catch (e) {
      lastError = e;
      const status = e.status ?? e.httpStatusCode ?? 0;
      // Only retry on rate limit (429) or server error (5xx)
      if (status === 429 || (status >= 500 && status < 600)) {
        if (attempt < delays.length) {
          console.warn(
            `[selector] Gemini ${status}, retrying in ${delays[attempt]}ms`
          );
          await sleep(delays[attempt]);
          continue;
        }
      }
      throw e; // Non-retryable error
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
