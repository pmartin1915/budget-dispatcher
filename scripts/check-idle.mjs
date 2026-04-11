#!/usr/bin/env node
// check-idle.mjs
//
// Portable activity gate for the Budget Dispatcher. Replaces the Linux-only
// `find -newermt` shell invocation that silently no-opped on Windows/macOS.
//
// Scans ~/.claude/projects recursively for any .jsonl file whose mtime is
// within the last N minutes (default 20). If ANY hot file is found, the user
// is considered active and the script exits 1 ("user-active"). Otherwise
// exit 0 ("idle"), meaning the dispatcher is free to spawn bounded work.
//
// Usage:  node scripts/check-idle.mjs [idle_minutes]
// Exit:   0 = idle, 1 = user-active, 2 = fatal error

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const idleMinutes = Number(process.argv[2] || 20);
if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
  process.stderr.write(`[check-idle] invalid idle_minutes: ${process.argv[2]}\n`);
  process.exit(2);
}

const cutoff = Date.now() - idleMinutes * 60_000;
const root = join(homedir(), ".claude", "projects");

if (!existsSync(root)) {
  // No transcripts dir → no way to tell if user is active → fail closed.
  process.stdout.write("user-active\n");
  process.exit(1);
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        yield* walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        yield full;
      }
    } catch {
      // ignore unreadable entries (locked files, symlink loops)
    }
  }
}

for (const f of walk(root)) {
  let mtime;
  try {
    mtime = statSync(f).mtimeMs;
  } catch {
    continue;
  }
  if (mtime > cutoff) {
    process.stdout.write("user-active\n");
    process.exit(1);
  }
}

process.stdout.write("idle\n");
process.exit(0);
