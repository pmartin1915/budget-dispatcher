#!/usr/bin/env node
// Budget Dispatcher Control -- interactive CLI for engine switching & monitoring.
// Usage: node scripts/control.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn, execSync } from "node:child_process";

import { resolveModel } from "./lib/router.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const CONFIG_PATH = join(REPO_ROOT, "config", "budget.json");
const SNAPSHOT_PATH = join(REPO_ROOT, "status", "usage-estimate.json");
const LAST_RUN_PATH = join(REPO_ROOT, "status", "budget-dispatch-last-run.json");
const LOG_PATH = join(REPO_ROOT, "status", "budget-dispatch-log.jsonl");
const PAUSE_PATH = join(REPO_ROOT, "config", "PAUSED");

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function showStatus() {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config/budget.json not found"); return; }

  const snapshot = readJson(SNAPSHOT_PATH);
  const lastRun = readJson(LAST_RUN_PATH);

  const override = config.engine_override ?? null;
  const nextEngine = override && override !== "auto"
    ? override
    : snapshot?.dispatch_authorized ? "claude" : "node";

  const paused = config.paused || existsSync(PAUSE_PATH);
  const headroom = snapshot?.trailing30?.headroom_pct;
  const wkActual = snapshot?.weekly?.actual_pct;
  const wkHeadroom = snapshot?.weekly?.headroom_pct;

  // Count today's runs
  let todayRuns = 0;
  try {
    const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
    const todayPrefix = new Date().toISOString().slice(0, 10);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (!obj.ts?.startsWith(todayPrefix)) break;
        if (obj.outcome !== "skipped" && obj.outcome !== "wrapper-success") todayRuns++;
      } catch { /* skip */ }
    }
  } catch { /* no log */ }

  const maxRuns = snapshot?.weekly?.effective_max_runs_per_day ?? config.max_runs_per_day ?? 8;

  console.log("\n  Budget Dispatcher Control");
  console.log("  " + "-".repeat(44));
  console.log(`  Engine:      ${override || "auto"} (next: ${nextEngine})`);
  console.log(`  Paused:      ${paused ? "\x1b[33mYES\x1b[0m" : "no"}`);
  console.log(`  Dry run:     ${config.dry_run ? "\x1b[33mON\x1b[0m" : "off"}`);
  if (headroom != null) {
    const hColor = headroom >= 0 ? "\x1b[32m" : "\x1b[31m";
    console.log(`  Headroom:    ${hColor}${headroom.toFixed(1)}%\x1b[0m`);
    console.log(`  Authorized:  ${snapshot.dispatch_authorized ? "\x1b[32mYES\x1b[0m" : "\x1b[31mNO\x1b[0m"}` +
      (snapshot.skip_reason ? ` (${snapshot.skip_reason})` : ""));
  }
  if (wkActual != null) {
    const wColor = wkHeadroom >= 0 ? "\x1b[32m" : "\x1b[31m";
    console.log(`  Weekly:      ${wkActual.toFixed(1)}% used (headroom ${wColor}${wkHeadroom?.toFixed(1)}%\x1b[0m)`);
  }
  console.log(`  Today:       ${todayRuns}/${maxRuns} runs`);
  if (lastRun) {
    const ts = lastRun.timestamp ? new Date(lastRun.timestamp).toLocaleTimeString() : "?";
    const dur = lastRun.duration_ms != null ? ` (${lastRun.duration_ms}ms)` : "";
    console.log(`  Last run:    ${lastRun.status || "?"} (${lastRun.error || lastRun.reason || ""}) at ${ts}${dur}`);
  }
  console.log();
}

function setEngine(engine) {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config not found"); return; }
  config.engine_override = engine === "auto" ? null : engine;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`  Engine override set to: ${engine}`);
}

function togglePause() {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config not found"); return; }
  config.paused = !config.paused;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`  Paused: ${config.paused}`);
}

function toggleDryRun() {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config not found"); return; }
  config.dry_run = !config.dry_run;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`  Dry run: ${config.dry_run ? "ON" : "OFF"}`);
}

function showPrediction() {
  const config = readJson(CONFIG_PATH);
  if (!config) { console.log("  Error: config not found"); return; }

  const projects = config.projects_in_rotation ?? [];
  if (projects.length === 0) { console.log("  No projects in rotation"); return; }

  // Read log for per-project last dispatch
  let lines = [];
  try { lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean); } catch { /* empty */ }

  const projectData = projects.map((proj) => {
    let lastTs = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.project === proj.slug && obj.outcome !== "skipped") { lastTs = obj.ts; break; }
      } catch { /* skip */ }
    }
    return { ...proj, last_dispatched: lastTs };
  });

  projectData.sort((a, b) => {
    if (!a.last_dispatched && !b.last_dispatched) return 0;
    if (!a.last_dispatched) return -1;
    if (!b.last_dispatched) return 1;
    return new Date(a.last_dispatched) - new Date(b.last_dispatched);
  });

  const top = projectData[0];
  const tasks = top.opportunistic_tasks ?? [];
  const task = tasks[0] || "?";
  const route = resolveModel(task, config.free_model_roster ?? {});

  console.log("\n  \x1b[36mNext Dispatch Prediction (heuristic)\x1b[0m");
  console.log("  " + "-".repeat(44));
  console.log(`  Project:  ${top.slug}`);
  console.log(`  Task:     ${task}`);
  console.log(`  Model:    \x1b[36m${route.model || route.delegate_to}\x1b[0m (${route.taskClass})`);
  console.log(`  Last run: ${top.last_dispatched ? new Date(top.last_dispatched).toLocaleString() : "never"}`);
  console.log();
}

function tailLog(n = 20) {
  let lines = [];
  try { lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean); } catch { console.log("  No log file"); return; }

  const recent = lines.slice(-n).reverse();
  console.log(`\n  Last ${Math.min(n, recent.length)} log entries:\n`);

  for (const line of recent) {
    try {
      const obj = JSON.parse(line);
      const ts = obj.ts ? new Date(obj.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
      const outcome = (obj.outcome || "?").padEnd(10);
      const info = [obj.project, obj.task, obj.reason, obj.error].filter(Boolean).join(" / ");

      let color = "\x1b[0m";
      if (obj.outcome === "success") color = "\x1b[32m";
      else if (obj.outcome === "error") color = "\x1b[31m";
      else if (obj.outcome === "skipped") color = "\x1b[90m";

      console.log(`  ${ts}  ${color}${outcome}\x1b[0m  ${info}`);
    } catch {
      console.log(`  (unparseable line)`);
    }
  }
  console.log();
}

function dispatchNow(dryRun) {
  const label = dryRun ? "Dry run" : "Real dispatch";
  console.log(`  ${label} starting...`);
  const args = ["scripts/dispatch.mjs", "--force"];
  if (dryRun) args.push("--dry-run");
  const child = spawn("node", args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("close", (code) => {
    console.log(`  ${label} exited with code ${code}`);
    showMenu();
  });
}

function openDashboard() {
  const port = 7380;
  try {
    spawn("cmd", ["/c", "start", `http://localhost:${port}`], { stdio: "ignore", detached: true }).unref();
    console.log(`  Opening http://localhost:${port} in browser`);
  } catch {
    console.log(`  Could not open browser. Visit http://localhost:${port}`);
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

function showMenu() {
  showStatus();
  console.log("  1) Auto    2) Free only    3) Claude");
  console.log("  4) Pause/Resume    5) Dry run toggle");
  console.log("  6) Dispatch now (dry-run)");
  console.log("  7) Dispatch now (real, --force)");
  console.log("  8) Show prediction (next project/task)");
  console.log("  9) Tail log (last 20 entries)");
  console.log("  0) Open dashboard in browser");
  console.log("  q) Quit");
  console.log();
  rl.question("  > ", (answer) => {
    const choice = answer.trim().toLowerCase();
    switch (choice) {
      case "1": setEngine("auto"); showMenu(); break;
      case "2": setEngine("node"); showMenu(); break;
      case "3": setEngine("claude"); showMenu(); break;
      case "4": togglePause(); showMenu(); break;
      case "5": toggleDryRun(); showMenu(); break;
      case "6": dispatchNow(true); break;
      case "7":
        rl.question("  Confirm real dispatch? (y/N) ", (a) => {
          if (a.trim().toLowerCase() === "y") dispatchNow(false);
          else { console.log("  Cancelled"); showMenu(); }
        });
        break;
      case "8": showPrediction(); showMenu(); break;
      case "9": tailLog(); showMenu(); break;
      case "0": openDashboard(); showMenu(); break;
      case "q": case "quit": case "exit": rl.close(); process.exit(0);
      default: console.log("  Unknown option"); showMenu();
    }
  });
}

showMenu();
