// router.test.mjs — Unit tests for resolveModel().
// Uses Node built-in test runner (node:test + node:assert/strict). Zero deps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../router.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal roster — flat classes, no overrides. */
function minimalRoster() {
  return {
    enabled: true,
    allow_only_listed_models: false,
    classes: {
      explore: "gemini-2.5-pro",
      audit: "gemini-2.5-pro",
      research: "gemini-2.5-pro",
      tests_gen: "codestral-latest",
      refactor: "codestral-latest",
      docs_gen: "mistral-large-latest",
    },
    claude_only: ["plan", "design", "architecture"],
    forbidden_models: ["gemini-3-pro-preview"],
    fallback_chain: ["gemini-2.5-pro", "gemini-2.5-flash", "mistral-large-latest"],
  };
}

/** Roster with per-project overrides. */
function rosterWithOverrides() {
  const roster = minimalRoster();
  roster.project_overrides = {
    "burn-wizard": {
      classes: {
        explore: ["gemini-2.5-flash", "gemini-2.5-pro"],
        tests_gen: "gemini-2.5-flash",
      },
      audit_models: {
        tests_gen: "mistral-large-latest",
        refactor: "gemini-2.5-pro",
      },
    },
  };
  return roster;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveModel — local tasks", () => {
  it("returns local for test, typecheck, lint, coverage", () => {
    const roster = minimalRoster();
    for (const task of ["test", "typecheck", "lint", "coverage"]) {
      const r = resolveModel(task, roster);
      assert.equal(r.delegate_to, "local");
      assert.equal(r.model, null);
      assert.equal(r.taskClass, "local");
      assert.deepEqual(r.candidates, []);
    }
  });

  it("returns local for unknown tasks", () => {
    const r = resolveModel("unknown-task-xyz", minimalRoster());
    assert.equal(r.delegate_to, "local");
  });
});

describe("resolveModel — claude-only tasks", () => {
  it("skips tasks whose resolved class is in claude_only", () => {
    const roster = minimalRoster();
    // claude_only checks taskClass, not raw task name.
    // Add a TASK_TO_CLASS-resolvable class to claude_only.
    roster.claude_only = ["audit"];
    const r = resolveModel("audit", roster);
    assert.equal(r.delegate_to, "skip");
    assert.equal(r.reason, "claude-only-task");
    assert.deepEqual(r.candidates, []);
  });

  it("tasks not in TASK_TO_CLASS default to local (not claude_only)", () => {
    const roster = minimalRoster();
    // "plan" is not in TASK_TO_CLASS, so it maps to "local" and returns
    // before the claude_only check
    const r = resolveModel("plan", roster);
    assert.equal(r.delegate_to, "local");
    assert.equal(r.taskClass, "local");
  });
});

describe("resolveModel — backward compat (no projectSlug)", () => {
  it("uses global classes when projectSlug omitted", () => {
    const roster = minimalRoster();
    const r = resolveModel("audit", roster);
    assert.equal(r.delegate_to, "gemini-2.5-pro");
    assert.equal(r.model, "gemini-2.5-pro");
    assert.equal(r.taskClass, "audit");
  });

  it("uses global classes when projectSlug is undefined", () => {
    const roster = minimalRoster();
    const r = resolveModel("audit", roster, undefined);
    assert.equal(r.delegate_to, "gemini-2.5-pro");
  });

  it("resolves each task class to the correct global model", () => {
    const roster = minimalRoster();
    assert.equal(resolveModel("explore", roster).model, "gemini-2.5-pro");
    assert.equal(resolveModel("research", roster).model, "gemini-2.5-pro");
    assert.equal(resolveModel("tests-gen", roster).model, "codestral-latest");
    assert.equal(resolveModel("refactor", roster).model, "codestral-latest");
    assert.equal(resolveModel("docs-gen", roster).model, "mistral-large-latest");
  });

  it("maps task aliases to the correct class", () => {
    const roster = minimalRoster();
    assert.equal(resolveModel("self-audit", roster).taskClass, "audit");
    assert.equal(resolveModel("add-tests", roster).taskClass, "tests_gen");
    assert.equal(resolveModel("clean", roster).taskClass, "refactor");
    assert.equal(resolveModel("jsdoc", roster).taskClass, "docs_gen");
    assert.equal(resolveModel("session-log", roster).taskClass, "docs_gen");
    assert.equal(resolveModel("proposal", roster).taskClass, "research");
    assert.equal(resolveModel("roadmap-review", roster).taskClass, "research");
  });
});

describe("resolveModel — per-project overrides", () => {
  it("uses project override when projectSlug matches", () => {
    const roster = rosterWithOverrides();
    const r = resolveModel("tests-gen", roster, "burn-wizard");
    assert.equal(r.delegate_to, "gemini-2.5-flash");
    assert.equal(r.model, "gemini-2.5-flash");
  });

  it("falls back to global when projectSlug has no override for that class", () => {
    const roster = rosterWithOverrides();
    // burn-wizard has no override for docs_gen
    const r = resolveModel("docs-gen", roster, "burn-wizard");
    assert.equal(r.delegate_to, "mistral-large-latest");
  });

  it("falls back to global when projectSlug is not in overrides", () => {
    const roster = rosterWithOverrides();
    const r = resolveModel("tests-gen", roster, "wilderness");
    assert.equal(r.delegate_to, "codestral-latest");
  });
});

describe("resolveModel — fallback chain ordering", () => {
  it("per-task chain comes first, then global fallback (no duplicates)", () => {
    const roster = rosterWithOverrides();
    const r = resolveModel("explore", roster, "burn-wizard");
    // burn-wizard explore = ["gemini-2.5-flash", "gemini-2.5-pro"]
    // global fallback = ["gemini-2.5-pro", "gemini-2.5-flash", "mistral-large-latest"]
    // merged (deduped): flash, pro, mistral-large
    assert.equal(r.candidates[0], "gemini-2.5-flash");
    assert.equal(r.candidates[1], "gemini-2.5-pro");
    assert.equal(r.candidates[2], "mistral-large-latest");
    assert.equal(r.candidates.length, 3);
  });

  it("global classes (string) get fallback chain appended", () => {
    const roster = minimalRoster();
    const r = resolveModel("audit", roster);
    // audit = "gemini-2.5-pro", fallback = ["gemini-2.5-pro", "gemini-2.5-flash", "mistral-large-latest"]
    // merged: pro, flash, mistral-large (pro already in per-task, so flash + mistral added)
    assert.equal(r.candidates[0], "gemini-2.5-pro");
    assert.equal(r.candidates[1], "gemini-2.5-flash");
    assert.equal(r.candidates[2], "mistral-large-latest");
  });
});

describe("resolveModel — audit model resolution", () => {
  it("returns project-specific audit model when configured", () => {
    const roster = rosterWithOverrides();
    const r = resolveModel("tests-gen", roster, "burn-wizard");
    assert.equal(r.auditModel, "mistral-large-latest");
  });

  it("returns null auditModel when not configured (triggers auto C-1)", () => {
    const roster = rosterWithOverrides();
    const r = resolveModel("docs-gen", roster, "burn-wizard");
    assert.equal(r.auditModel, null);
  });

  it("returns null auditModel when no project overrides", () => {
    const roster = minimalRoster();
    const r = resolveModel("audit", roster);
    assert.equal(r.auditModel, null);
  });
});

describe("resolveModel — forbidden model filtering", () => {
  it("excludes forbidden models from candidates", () => {
    const roster = minimalRoster();
    roster.classes.audit = "gemini-3-pro-preview"; // forbidden
    const r = resolveModel("audit", roster);
    // Primary is forbidden, but fallback chain has viable models
    assert.ok(!r.candidates.includes("gemini-3-pro-preview"));
    assert.equal(r.delegate_to, "gemini-2.5-pro"); // first viable from fallback
  });

  it("returns skip when all candidates are forbidden", () => {
    const roster = minimalRoster();
    roster.classes.audit = "gemini-3-pro-preview";
    roster.fallback_chain = ["gemini-3-pro-preview"];
    roster.forbidden_models = ["gemini-3-pro-preview"];
    const r = resolveModel("audit", roster);
    assert.equal(r.delegate_to, "skip");
    assert.equal(r.reason, "no-viable-free-model");
  });
});

describe("resolveModel — allow_only_listed_models", () => {
  it("does not filter models that are in classes or fallback_chain even when flag is true", () => {
    const roster = minimalRoster();
    roster.allow_only_listed_models = true;
    const r = resolveModel("audit", roster);
    // All candidates come from classes + fallback_chain, so all are in allowedSet
    assert.ok(r.candidates.length > 0);
    assert.equal(r.delegate_to, "gemini-2.5-pro");
  });

  it("allows models in fallback_chain when flag is false", () => {
    const roster = minimalRoster();
    roster.allow_only_listed_models = false;
    roster.fallback_chain = ["gemini-2.5-pro", "some-unlisted-model"];
    const r = resolveModel("audit", roster);
    assert.ok(r.candidates.includes("some-unlisted-model"));
  });
});

describe("resolveModel — array-style class entries", () => {
  it("uses array as ordered fallback chain", () => {
    const roster = minimalRoster();
    roster.classes.explore = ["gemini-2.5-flash", "gemini-2.5-pro"];
    const r = resolveModel("explore", roster);
    assert.equal(r.candidates[0], "gemini-2.5-flash");
    assert.equal(r.candidates[1], "gemini-2.5-pro");
    // delegate_to is first candidate
    assert.equal(r.delegate_to, "gemini-2.5-flash");
  });
});

describe("resolveModel — edge cases", () => {
  it("handles empty classes gracefully", () => {
    const roster = minimalRoster();
    roster.classes = {};
    roster.fallback_chain = ["gemini-2.5-pro"];
    const r = resolveModel("audit", roster);
    // No class entry, but fallback chain provides candidates
    assert.equal(r.delegate_to, "gemini-2.5-pro");
  });

  it("handles missing fallback_chain", () => {
    const roster = minimalRoster();
    delete roster.fallback_chain;
    const r = resolveModel("audit", roster);
    assert.equal(r.delegate_to, "gemini-2.5-pro");
    assert.equal(r.candidates.length, 1);
  });

  it("handles missing forbidden_models", () => {
    const roster = minimalRoster();
    delete roster.forbidden_models;
    const r = resolveModel("audit", roster);
    assert.equal(r.delegate_to, "gemini-2.5-pro");
  });

  it("handles null/undefined roster fields without throwing", () => {
    const roster = { enabled: true };
    const r = resolveModel("audit", roster);
    // No classes, no fallback → skip
    assert.equal(r.delegate_to, "skip");
    assert.equal(r.reason, "no-viable-free-model");
  });
});
