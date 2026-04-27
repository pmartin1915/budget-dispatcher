// schemas.mjs — JSON schema validation for LLM responses (R-1).
// Uses ajv to catch wrong field types before they cause downstream crashes.

import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, coerceTypes: false });

// Audit response schema — drives revert decisions in worker.mjs auditChanges()
// and verify-commit.mjs clinicalAudit().
const auditResponseSchema = {
  type: "object",
  required: ["hasCritical"],
  properties: {
    hasCritical: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          issue: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
  additionalProperties: true,
};

// Selector response schema — belt-and-suspenders behind I-1 native JSON mode.
const selectorResponseSchema = {
  type: "object",
  required: ["project", "task"],
  properties: {
    project: { type: "string", minLength: 1 },
    task: { type: "string", minLength: 1 },
    reason: { type: "string" },
  },
  additionalProperties: true,
};

// Pipeline definition schema — operator-authored ai/pipelines.json files.
// Each pipeline is a named multi-step initiative the dispatcher executes
// step-by-step across cron cycles. Steps are leaf tasks from the existing
// taxonomy (audit, refactor, tests-gen, etc); the pipeline layer just
// sequences them. depends_on is explicit (not implicit-by-id-order) so
// future parallel steps work without a schema change.
const pipelineDefSchema = {
  type: "object",
  required: ["schema_version", "pipelines"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    pipelines: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "steps"],
        properties: {
          name: { type: "string", minLength: 1, pattern: "^[a-z0-9][a-z0-9_-]*$" },
          description: { type: "string" },
          goal_signal: { type: "string" },
          active: { type: "boolean" },
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "task"],
              properties: {
                id: { type: "integer", minimum: 1 },
                task: { type: "string", minLength: 1 },
                target: { type: "string" },
                description: { type: "string" },
                model: { type: "string" },
                depends_on: {
                  type: "array",
                  items: { type: "integer", minimum: 1 },
                },
              },
              additionalProperties: true,
            },
          },
          abort_on: {
            type: "object",
            properties: {
              audit_critical: { type: "boolean" },
              consecutive_step_failures: { type: "integer", minimum: 1 },
              test_failure_streak: { type: "integer", minimum: 1 },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};

// Pipeline state schema — dispatcher-mutated ai/pipeline-state.json. Tracks
// per-step outcomes, branch names (for merge correlation), and abort state.
// Operator should not hand-edit unless intentionally resuming or clearing
// a stuck pipeline.
const pipelineStateSchema = {
  type: "object",
  required: ["schema_version", "step_states"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    active_pipeline: { type: ["string", "null"] },
    current_step_id: { type: ["integer", "null"], minimum: 1 },
    step_states: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["outcome"],
        properties: {
          outcome: {
            type: "string",
            enum: ["pending", "in-progress", "success", "failed"],
          },
          started_ts: { type: "string" },
          completed_ts: { type: "string" },
          merged_ts: { type: ["string", "null"] },
          branch: { type: ["string", "null"] },
          reason: { type: "string" },
        },
        additionalProperties: true,
      },
    },
    consecutive_failures: { type: "integer", minimum: 0 },
    aborted: {
      type: ["object", "null"],
      properties: {
        reason: { type: "string" },
        ts: { type: "string" },
      },
      additionalProperties: true,
    },
    history: {
      type: "array",
      items: { type: "object" },
    },
  },
  additionalProperties: true,
};

const validateAudit = ajv.compile(auditResponseSchema);
const validateSelector = ajv.compile(selectorResponseSchema);
const validatePipelineDefFn = ajv.compile(pipelineDefSchema);
const validatePipelineStateFn = ajv.compile(pipelineStateSchema);

/**
 * Validate and return an audit response, or throw with details.
 * @param {unknown} data - Parsed JSON from LLM
 * @returns {{ hasCritical: boolean, findings: object[], summary: string }}
 */
export function validateAuditResponse(data) {
  if (validateAudit(data)) {
    return {
      hasCritical: data.hasCritical === true,
      findings: data.findings ?? [],
      summary: data.summary ?? "",
    };
  }
  const errors = validateAudit.errors
    .map((e) => `${e.instancePath || "/"}: ${e.message}`)
    .join("; ");
  throw new Error(`audit response schema violation: ${errors}`);
}

/**
 * Validate and return a selector response, or throw with details.
 * @param {unknown} data - Parsed JSON from LLM
 * @returns {{ project: string, task: string, reason: string }}
 */
export function validateSelectorResponse(data) {
  if (validateSelector(data)) {
    return {
      project: data.project,
      task: data.task,
      reason: data.reason ?? "",
    };
  }
  const errors = validateSelector.errors
    .map((e) => `${e.instancePath || "/"}: ${e.message}`)
    .join("; ");
  throw new Error(`selector response schema violation: ${errors}`);
}

/**
 * Validate a pipeline definition file. Returns {ok:true, errors:[]} on
 * success, {ok:false, errors:[...]} on schema violation. Caller decides
 * whether to throw or fall through to leaf-task selector.
 * @param {unknown} data - Parsed pipelines.json
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePipelineDef(data) {
  if (validatePipelineDefFn(data)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: validatePipelineDefFn.errors.map((e) => `${e.instancePath || "/"}: ${e.message}`),
  };
}

/**
 * Validate pipeline state file shape. Same shape as validatePipelineDef.
 * @param {unknown} data - Parsed pipeline-state.json
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePipelineState(data) {
  if (validatePipelineStateFn(data)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: validatePipelineStateFn.errors.map((e) => `${e.instancePath || "/"}: ${e.message}`),
  };
}
