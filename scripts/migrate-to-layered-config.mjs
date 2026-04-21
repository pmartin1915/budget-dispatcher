#!/usr/bin/env node
// migrate-to-layered-config.mjs
//
// One-time migration: extracts machine-specific fields from the existing
// budget.json into config/local.json so the new layered config system works.
//
// Safe to run multiple times — skips if local.json already exists.
//
// Usage:  git pull && node scripts/migrate-to-layered-config.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, "..", "config");
const SHARED_PATH = join(CONFIG_DIR, "shared.json");
const LOCAL_PATH = join(CONFIG_DIR, "local.json");
const LEGACY_PATH = join(CONFIG_DIR, "budget.json");

// Fields that belong in local.json (machine-specific)
const LOCAL_FIELDS = [
  "machine_name",
  "paused",
  "dry_run",
  "projects_in_rotation",
  "kill_switches",
];

// Fields where local can partially override shared (deep merge targets)
const OVERRIDE_FIELDS = [
  "alerting",   // local may set alerting.enabled = true
];

if (existsSync(LOCAL_PATH)) {
  console.log("[migrate] config/local.json already exists — skipping migration.");
  console.log("[migrate] To re-run, delete config/local.json first.");
  process.exit(0);
}

if (!existsSync(LEGACY_PATH)) {
  console.log("[migrate] No config/budget.json found — nothing to migrate.");
  console.log("[migrate] Copy config/local.example.json to config/local.json and customize.");
  process.exit(1);
}

if (!existsSync(SHARED_PATH)) {
  console.log("[migrate] No config/shared.json found — run git pull first.");
  process.exit(1);
}

let legacy, shared;
try {
  legacy = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
} catch (e) {
  console.error("[migrate] Failed to parse budget.json:", e.message);
  process.exit(1);
}

try {
  shared = JSON.parse(readFileSync(SHARED_PATH, "utf8"));
} catch (e) {
  console.error("[migrate] Failed to parse shared.json:", e.message);
  process.exit(1);
}

// Build local.json from machine-specific fields
const local = {};

// Set machine_name from hostname if not already in budget.json
local.machine_name = legacy.machine_name || hostname().toLowerCase();

// Extract machine-specific fields
for (const field of LOCAL_FIELDS) {
  if (field === "machine_name") continue; // already handled
  if (legacy[field] !== undefined) {
    local[field] = legacy[field];
    console.log(`[migrate] Extracted: ${field}`);
  }
}

// Extract override fields where local differs from shared
for (const field of OVERRIDE_FIELDS) {
  if (legacy[field] && shared[field]) {
    const diff = {};
    let hasDiff = false;
    for (const [k, v] of Object.entries(legacy[field])) {
      if (JSON.stringify(v) !== JSON.stringify(shared[field][k])) {
        diff[k] = v;
        hasDiff = true;
      }
    }
    if (hasDiff) {
      local[field] = diff;
      console.log(`[migrate] Extracted override: ${field} (${Object.keys(diff).join(", ")})`);
    }
  }
}

// Write local.json
writeFileSync(LOCAL_PATH, JSON.stringify(local, null, 2) + "\n", "utf8");
console.log(`\n[migrate] Created config/local.json with ${Object.keys(local).length} fields.`);
console.log(`[migrate] Machine: ${local.machine_name}`);
console.log(`[migrate] Projects: ${(local.projects_in_rotation || []).length}`);

// Verify: load merged config and compare critical fields
const { loadConfig } = await import("./lib/config.mjs");
const merged = loadConfig();

const legacyProjects = (legacy.projects_in_rotation || []).map(p => p.slug).join(", ");
const mergedProjects = (merged.projects_in_rotation || []).map(p => p.slug).join(", ");

if (legacyProjects === mergedProjects) {
  console.log(`[migrate] Verified: project rotation matches (${(merged.projects_in_rotation || []).length} projects).`);
} else {
  console.warn(`[migrate] WARNING: project rotation mismatch!`);
  console.warn(`  legacy:  ${legacyProjects}`);
  console.warn(`  merged:  ${mergedProjects}`);
}

console.log(`[migrate] Engine: ${merged.engine_override || "auto"} (from shared.json)`);
console.log(`[migrate] Weekly reset: day ${merged.weekly?.deadline_scaling?.resets_on_day_of_week}, hour ${merged.weekly?.deadline_scaling?.resets_at_hour_utc} UTC`);
console.log(`\n[migrate] Done. Test with: node scripts/dispatch.mjs --force --dry-run`);
