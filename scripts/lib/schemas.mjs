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

const validateAudit = ajv.compile(auditResponseSchema);
const validateSelector = ajv.compile(selectorResponseSchema);

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
