#!/usr/bin/env node
// circuit-breaker-cli.mjs -- thin JSON-IO wrapper that PS1 calls.
//
// Subcommands:
//   gate              Read state, print gate decision. Read-only.
//   record-pull       After a successful git pull that changed SHA, reset
//                     failure counter and stamp the new SHA.
//   record-dispatch   After dispatch returns, increment-on-failure /
//                     reset-on-success the counter; return whether the freeze
//                     transition just occurred so the caller can fire ntfy.
//
// State file: <repo>/status/last-auto-pull.json (gitignored, machine-local).
// Pass --state <path> to override; defaults to repo-relative resolution.
//
// Exit codes:
//   0  decision printed on stdout (always JSON)
//   1  unrecoverable error (e.g. status dir not writable; stderr explains)
//
// Corrupt state file is recovered as fresh state -- a one-time stderr warn
// surfaces the corruption without trapping the breaker in a forever-frozen
// state that nothing can clear automatically. The handoff DO-NOT for this
// session forbids auto-clear of a real freeze, but corruption is a separate
// failure mode (the freeze metadata was already lost). PAL audit may
// recommend the other direction.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freshState,
  evaluateGate,
  recordPullOutcome,
  recordDispatchOutcome,
} from "./circuit-breaker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/lib/circuit-breaker-cli.mjs -> repo root is two parents up.
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_STATE_PATH = resolve(DEFAULT_REPO_ROOT, "status", "last-auto-pull.json");

function parseArgs(argv) {
  const out = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.opts[key] = true;
      } else {
        out.opts[key] = next;
        i++;
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
}

// Returns { state, warning, corrupt }.
// - corrupt:false on missing/empty file -> fresh state, no warning.
// - corrupt:true on parse error or non-object payload -> fresh state, warning
//   describes the issue. The CLI EMBEDS the warning in its JSON stdout (NOT
//   stderr), because the PS1 wrapper merges streams via 2>&1 and a stray
//   stderr line would break ConvertFrom-Json on the next cycle. The PS1
//   wrapper treats corrupt:true as "skip pull this cycle, do not freeze"
//   so a bad state file doesn't propagate a buggy commit.
function readState(statePath) {
  if (!existsSync(statePath)) {
    return { state: freshState(), warning: null, corrupt: false };
  }
  try {
    const raw = readFileSync(statePath, "utf8");
    if (!raw.trim()) {
      return { state: freshState(), warning: null, corrupt: false };
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        state: freshState(),
        warning: `state file at ${statePath} is not an object; treating as fresh`,
        corrupt: true,
      };
    }
    return { state: parsed, warning: null, corrupt: false };
  } catch (err) {
    return {
      state: freshState(),
      warning: `failed to parse state file ${statePath} (${err.message}); treating as fresh`,
      corrupt: true,
    };
  }
}

function writeStateAtomic(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${statePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  // Same-volume rename is atomic on NTFS and POSIX. tmp lives in the same
  // dir so this assumption holds.
  renameSync(tmpPath, statePath);
}

function dieUsage() {
  process.stderr.write(
    "usage: circuit-breaker-cli.mjs <gate|record-pull|record-dispatch> [--state <path>] [--sha <sha>] [--exit-code <n>]\n",
  );
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) dieUsage();

  const statePath = args.opts.state ?? DEFAULT_STATE_PATH;

  try {
    if (cmd === "gate") {
      const { state, warning, corrupt } = readState(statePath);
      // Fail-safe on corruption: skip the pull this cycle, do NOT freeze.
      // Frozen requires the explicit 3-strike transition; corruption is a
      // separate signal that should be surfaced and resolved manually
      // without trapping the breaker in a permanent freeze.
      if (corrupt) {
        process.stdout.write(
          JSON.stringify({
            shouldPull: false,
            frozen: false,
            sha: null,
            reason: "state-file-corrupt",
            warning,
          }) + "\n",
        );
        return;
      }
      const gate = evaluateGate(state);
      process.stdout.write(JSON.stringify({ ...gate, warning: null }) + "\n");
      return;
    }

    if (cmd === "record-pull") {
      const sha = args.opts.sha;
      if (!sha) {
        process.stderr.write("record-pull requires --sha <newShaShort>\n");
        process.exit(1);
      }
      const { state } = readState(statePath);
      const next = recordPullOutcome(state, String(sha));
      writeStateAtomic(statePath, next);
      // Successful exit code is the success signal; PS1 discards stdout.
      return;
    }

    if (cmd === "record-dispatch") {
      if (args.opts["exit-code"] === undefined) {
        process.stderr.write("record-dispatch requires --exit-code <n>\n");
        process.exit(1);
      }
      const exitCode = Number.parseInt(String(args.opts["exit-code"]), 10);
      if (!Number.isFinite(exitCode)) {
        process.stderr.write(`record-dispatch: exit-code must be an integer (got "${args.opts["exit-code"]}")\n`);
        process.exit(1);
      }
      const { state, warning } = readState(statePath);
      const result = recordDispatchOutcome(state, exitCode, state?.sha ?? null);
      writeStateAtomic(statePath, result.state);
      process.stdout.write(
        JSON.stringify({
          state: result.state,
          shouldFireFreezeNtfy: result.shouldFireFreezeNtfy,
          freezeReason: result.freezeReason,
          warning,
        }) + "\n",
      );
      return;
    }

    process.stderr.write(`circuit-breaker: unknown subcommand "${cmd}"\n`);
    dieUsage();
  } catch (err) {
    process.stderr.write(`circuit-breaker: ${err.message}\n`);
    process.exit(1);
  }
}

main();
