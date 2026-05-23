import { isAbsolute, relative } from "node:path";
import { matches } from "./matcher.js";
import type { Effect, Operation, ParsedRule } from "./rules.js";

/**
 * Evaluate access rules for a given operation on an absolute path.
 *
 * Rules are processed top-to-bottom (first-match-wins).
 * Trust scoping: an `allow` rule only takes effect when the resolved path is
 * at or below the rule's `configDir`.
 *
 * Baseline policy (when no rule matches):
 * - Path at/below projectRoot → allow
 * - Path outside projectRoot → deny
 *
 * @param rules       - Ordered list of parsed rules (global first, project last).
 * @param operation   - The operation being attempted.
 * @param absolutePath - The resolved absolute path being accessed.
 * @param projectRoot - The session's working directory (resolved absolute path).
 */
export function evaluate(rules: ParsedRule[], operation: Operation, absolutePath: string, projectRoot: string): Effect {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`evaluate: absolutePath must be absolute, got "${absolutePath}"`);
  }
  if (!isAbsolute(projectRoot)) {
    throw new Error(`evaluate: projectRoot must be absolute, got "${projectRoot}"`);
  }

  for (const rule of rules) {
    // 1. Operation must match.
    if (!rule.operations.includes(operation)) continue;

    // 2. Path must match the pattern.
    if (!matches(rule.pattern, rule.configDir, absolutePath)) continue;

    // 3. Trust scoping: allow rules are only effective within the config's directory.
    if (rule.effect === "allow") {
      const rel = relative(rule.configDir, absolutePath);
      if (rel.startsWith("..")) {
        // Path is outside the config's directory — skip this allow rule.
        continue;
      }
    }

    return rule.effect;
  }

  // Baseline policy.
  const rel = relative(projectRoot, absolutePath);
  return rel.startsWith("..") ? "deny" : "allow";
}
