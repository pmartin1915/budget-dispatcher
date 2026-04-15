// scan.mjs — Deterministic security scanning for generated code (S-7).
// Lightweight, zero-dependency alternative to Semgrep/gitleaks.
// Runs on every generated diff before commit.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Secret patterns — regex + description.
 * Catches accidentally embedded API keys, tokens, and credentials.
 * Based on gitleaks default rules + common Node.js patterns.
 */
const SECRET_PATTERNS = [
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "AWS Secret Key", pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/g },
  { name: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
  { name: "GitHub OAuth", pattern: /gho_[A-Za-z0-9_]{36,}/g },
  { name: "Slack Token", pattern: /xox[bpsa]-[0-9A-Za-z-]{10,}/g },
  { name: "Slack Webhook", pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
  { name: "Private Key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: "npm Token", pattern: /npm_[A-Za-z0-9]{36}/g },
  { name: "Generic API Key assignment", pattern: /(?:api_key|apikey|api_secret|secret_key)\s*[:=]\s*["'][A-Za-z0-9_\-/.+=]{20,}["']/gi },
  { name: "Bearer Token", pattern: /Bearer\s+[A-Za-z0-9_\-/.+=]{20,}/g },
  { name: "Password assignment", pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/gi },
  { name: "Connection String", pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+:[^\s"']+@/g },
];

/**
 * Security anti-patterns — deterministic code quality checks.
 * Catches common vulnerabilities in generated JavaScript/TypeScript.
 */
const CODE_PATTERNS = [
  { name: "eval() usage", pattern: /\beval\s*\(/g, severity: "HIGH" },
  { name: "Function constructor", pattern: /new\s+Function\s*\(/g, severity: "HIGH" },
  { name: "child_process.exec (shell injection)", pattern: /\bexec\s*\(\s*[`"'].*\$\{/g, severity: "HIGH" },
  { name: "process.env access in generated code", pattern: /process\.env\.[A-Z_]*KEY/gi, severity: "CRITICAL" },
  { name: "process.env dump", pattern: /JSON\.stringify\s*\(\s*process\.env\s*\)/g, severity: "CRITICAL" },
  { name: "require('child_process')", pattern: /require\s*\(\s*['"]child_process['"]\s*\)/g, severity: "MEDIUM" },
  { name: "fetch/http to external URL", pattern: /(?:fetch|https?\.(?:get|post|request))\s*\(\s*['"`]https?:\/\/(?!localhost)/g, severity: "MEDIUM" },
  { name: "fs.writeFileSync to absolute path", pattern: /writeFileSync\s*\(\s*['"`]\/|writeFileSync\s*\(\s*['"`][A-Z]:\\/g, severity: "HIGH" },
];

/**
 * Scan a list of files for secrets and security anti-patterns.
 * @param {string[]} relPaths - Relative file paths
 * @param {string} basePath - Absolute base directory
 * @returns {{ clean: boolean, findings: object[] }}
 */
export function scanFiles(relPaths, basePath) {
  const findings = [];

  for (const relPath of relPaths) {
    // Only scan code files
    if (!/\.(js|mjs|cjs|ts|tsx|jsx|json|md|txt|yml|yaml|env|sh|ps1)$/i.test(relPath)) {
      continue;
    }

    let content;
    try {
      content = readFileSync(resolve(basePath, relPath), "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");

    // Check secrets
    for (const rule of SECRET_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (rule.pattern.test(lines[i])) {
          findings.push({
            file: relPath,
            line: i + 1,
            rule: rule.name,
            severity: "CRITICAL",
            type: "secret",
          });
        }
        rule.pattern.lastIndex = 0; // Reset regex state
      }
    }

    // Check code patterns
    for (const rule of CODE_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (rule.pattern.test(lines[i])) {
          findings.push({
            file: relPath,
            line: i + 1,
            rule: rule.name,
            severity: rule.severity,
            type: "code",
          });
        }
        rule.pattern.lastIndex = 0;
      }
    }
  }

  return {
    clean: findings.length === 0,
    findings,
    critical: findings.filter((f) => f.severity === "CRITICAL"),
    high: findings.filter((f) => f.severity === "HIGH"),
  };
}
