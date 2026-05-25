import { isAbsolute } from "node:path";
import { matches } from "./matcher.js";
import type { Effect, Operation, ParsedRule } from "./rules.js";
import { isDescendantOf } from "./walk.js";

/**
 * Determine whether a rule's operation level covers an incoming operation.
 *
 * Semantics — "write implies read":
 *   allow + "read":  covers only reads
 *   allow + "write": covers both reads and writes
 *   deny  + "read":  covers both reads and writes (can't read → can't write)
 *   deny  + "write": covers only writes
 */
function ruleApplies(effect: Effect, ruleOps: Operation, incomingOp: Operation): boolean {
  if (effect === "allow") {
    return ruleOps === "write" || incomingOp === "read";
  }
  return ruleOps === "read" || incomingOp === "write";
}

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
    // 1. Operation must cover the incoming operation.
    if (!ruleApplies(rule.effect, rule.operations, operation)) continue;

    // 2. Path must match the pattern.
    if (!matches(rule.pattern, rule.configDir, absolutePath)) continue;

    // 3. Trust scoping: allow rules are only effective within the config's directory.
    if (rule.effect === "allow") {
      if (!isDescendantOf(rule.configDir, absolutePath)) {
        // Path is outside the config's directory — skip this allow rule.
        continue;
      }
    }

    return rule.effect;
  }

  // Baseline policy.
  return isDescendantOf(projectRoot, absolutePath) ? "allow" : "deny";
}
