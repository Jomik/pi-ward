import { isAbsolute } from "node:path";
import { matches } from "./matcher.js";
import type { Effect, Operation, ParsedRule } from "./rules.js";
import { isDescendantOf } from "./walk.js";

export type EvaluateResult =
  | { effect: "allow"; source: "rule"; pattern: string; configDir: string }
  | { effect: "allow"; source: "baseline" }
  | { effect: "deny"; source: "rule"; pattern: string; configDir: string }
  | { effect: "deny"; source: "baseline" };

/**
 * Does an operation level cover an incoming operation for a given effect?
 *
 * "Write implies read" semantics:
 * - allow + write → covers read and write
 * - allow + read  → covers only read
 * - deny  + read  → covers read and write
 * - deny  + write → covers only write
 */
export function operationCovers(effect: Effect, declaredOp: Operation, incomingOp: Operation): boolean {
  if (effect === "allow") {
    return declaredOp === "write" || incomingOp === "read";
  }
  return declaredOp === "read" || incomingOp === "write";
}

function ruleApplies(effect: Effect, ruleOps: Operation, incomingOp: Operation): boolean {
  return operationCovers(effect, ruleOps, incomingOp);
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
export function evaluate(
  rules: ParsedRule[],
  operation: Operation,
  absolutePath: string,
  projectRoot: string,
): EvaluateResult {
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
    if (!matches(rule.pattern, rule.configDir, absolutePath, rule.homeDir)) continue;

    // 3. Trust scoping: allow rules are only effective within the config's directory.
    if (rule.effect === "allow") {
      if (!isDescendantOf(rule.configDir, absolutePath)) {
        // Path is outside the config's directory — skip this allow rule.
        continue;
      }
    }

    return rule.effect === "allow"
      ? { effect: "allow", source: "rule", pattern: rule.rawPattern, configDir: rule.configDir }
      : { effect: "deny", source: "rule", pattern: rule.rawPattern, configDir: rule.configDir };
  }

  // Baseline policy.
  return isDescendantOf(projectRoot, absolutePath)
    ? { effect: "allow", source: "baseline" }
    : { effect: "deny", source: "baseline" };
}
