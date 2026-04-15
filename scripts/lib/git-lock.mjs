// git-lock.mjs -- R-7: remove stale .git/index.lock files left behind by
// crashed git operations. Safe at dispatcher startup because
// run-dispatcher.ps1's Global\claude-budget-dispatcher mutex (R-3)
// guarantees no other dispatcher instance is mid-git-op when this runs.

import { statSync, unlinkSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIR = resolve(__dirname, "..", "..", "status");
const FSCK_MARKER = resolve(STATUS_DIR, "last-fsck.txt");

const STALE_AGE_MS = 30 * 60 * 1000; // 30 min

/**
 * Check each project's .git/index.lock and remove any whose mtime is older
 * than STALE_AGE_MS. Silent on ENOENT (common case); logs on other errors
 * and continues.
 *
 * @param {string[]} projectPaths - Absolute paths to rotation project clones.
 * @param {number} [now] - Injected clock for tests (defaults to Date.now()).
 * @returns {Array<{ lockPath: string, ageMs: number }>} Removed locks.
 */
export function sweepStaleIndexLocks(projectPaths, now = Date.now()) {
  const removed = [];
  for (const projectPath of projectPaths) {
    const lockPath = resolve(projectPath, ".git", "index.lock");
    try {
      const st = statSync(lockPath);
      const ageMs = now - st.mtimeMs;
      if (ageMs > STALE_AGE_MS) {
        unlinkSync(lockPath);
        removed.push({ lockPath, ageMs });
        console.warn(
          `[git-lock] removed stale ${lockPath} (age=${Math.round(ageMs / 1000)}s)`
        );
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        console.warn(`[git-lock] check ${lockPath}: ${e.message}`);
      }
    }
  }
  return removed;
}

/**
 * Run `git fsck` on rotation projects weekly (C-4).
 * Detects early signs of object store corruption from concurrent worktree
 * operations. Writes a marker file with the last-run date to avoid running
 * more than once per week.
 * @param {string[]} projectPaths
 * @returns {{ ran: boolean, errors: string[] }}
 */
export function weeklyGitFsck(projectPaths) {
  // Check if we've already run this week
  if (existsSync(FSCK_MARKER)) {
    try {
      const lastRun = readFileSync(FSCK_MARKER, "utf8").trim();
      const daysSince = (Date.now() - new Date(lastRun).getTime()) / 86_400_000;
      if (daysSince < 7) {
        return { ran: false, errors: [] };
      }
    } catch {
      // Corrupt marker — run fsck
    }
  }

  const errors = [];
  for (const projectPath of projectPaths) {
    try {
      execFileSync("git", ["fsck", "--no-dangling", "--no-progress"], {
        cwd: projectPath,
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (e) {
      const stderr = e.stderr?.toString() ?? e.message;
      errors.push(`${projectPath}: ${stderr.slice(0, 500)}`);
      console.error(`[git-fsck] errors in ${projectPath}: ${stderr.slice(0, 200)}`);
    }
  }

  // Write marker
  try {
    writeFileSync(FSCK_MARKER, new Date().toISOString());
  } catch {
    // Non-fatal
  }

  if (errors.length === 0) {
    console.log(`[git-fsck] all ${projectPaths.length} projects clean`);
  }

  return { ran: true, errors };
}
