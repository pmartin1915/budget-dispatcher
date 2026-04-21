// config.mjs — Layered config loader.
// Merges config/shared.json (committed) + config/local.json (gitignored).
// Falls back to legacy config/budget.json if shared.json doesn't exist yet.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, "..", "..", "config");

const SHARED_PATH = join(CONFIG_DIR, "shared.json");
const LOCAL_PATH = join(CONFIG_DIR, "local.json");
const LEGACY_PATH = join(CONFIG_DIR, "budget.json");

/**
 * Deep merge b into a. Arrays from b replace (not concat) arrays in a.
 * @param {object} a - base
 * @param {object} b - overrides
 * @returns {object} merged (mutates a)
 */
function deepMerge(a, b) {
  for (const key of Object.keys(b)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (
      b[key] !== null &&
      typeof b[key] === "object" &&
      !Array.isArray(b[key]) &&
      a[key] !== null &&
      typeof a[key] === "object" &&
      !Array.isArray(a[key])
    ) {
      deepMerge(a[key], b[key]);
    } else {
      a[key] = b[key];
    }
  }
  return a;
}

/**
 * Load merged config. Priority: local.json fields override shared.json fields.
 * Falls back to legacy budget.json if shared.json not found (migration path).
 * @returns {object|null}
 */
export function loadConfig() {
  // Legacy path: if shared.json doesn't exist, use budget.json directly
  if (!existsSync(SHARED_PATH)) {
    if (!existsSync(LEGACY_PATH)) return null;
    try {
      return JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
    } catch {
      return null;
    }
  }

  let shared;
  try {
    shared = JSON.parse(readFileSync(SHARED_PATH, "utf8"));
  } catch {
    return null;
  }

  // Apply local overrides if present
  if (existsSync(LOCAL_PATH)) {
    try {
      const local = JSON.parse(readFileSync(LOCAL_PATH, "utf8"));
      deepMerge(shared, local);
    } catch (e) {
      console.error("[config] WARNING: local.json parse error:", e.message);
      // Continue with shared-only — don't fail
    }
  }

  return shared;
}

/**
 * Write back to the effective config file.
 * If layered mode (shared.json exists), writes to local.json.
 * Otherwise writes to legacy budget.json.
 * Only writes the fields that differ from shared.json.
 * @param {object} config - full merged config to persist mutations from
 * @param {string} key - top-level key that changed
 * @param {any} value - new value
 */
export function writeConfigField(key, value) {
  if (existsSync(SHARED_PATH)) {
    // Layered mode: read local, patch field, write back
    let local = {};
    if (existsSync(LOCAL_PATH)) {
      try { local = JSON.parse(readFileSync(LOCAL_PATH, "utf8")); } catch { local = {}; }
    }
    local[key] = value;
    writeFileSync(LOCAL_PATH, JSON.stringify(local, null, 2) + "\n", "utf8");
  } else {
    // Legacy mode: read budget.json, patch, write back
    if (!existsSync(LEGACY_PATH)) return;
    try {
      const config = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
      config[key] = value;
      writeFileSync(LEGACY_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
    } catch { /* skip */ }
  }
}

/**
 * Returns the path where mutations should be written (for callers that
 * need to do complex multi-field writes).
 */
export function getMutableConfigPath() {
  return existsSync(SHARED_PATH) ? LOCAL_PATH : LEGACY_PATH;
}

/**
 * Returns the config directory path.
 */
export function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Materialize merged config to budget.json so legacy code (dashboard, control)
 * continues to work with readJson(CONFIG_PATH). Call once at process startup.
 * No-op if shared.json doesn't exist (legacy mode).
 * @returns {object|null} merged config
 */
export function materializeConfig() {
  const config = loadConfig();
  if (!config) return null;

  // Only write if in layered mode (shared.json exists)
  if (existsSync(SHARED_PATH)) {
    writeFileSync(LEGACY_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
  return config;
}

export { SHARED_PATH, LOCAL_PATH, LEGACY_PATH, CONFIG_DIR };
