import { evaluate } from "./evaluator.js";
import type { GrantStore } from "./grants.js";
import { matchesProjectGrants } from "./grants.js";
import type { ParsedGrant } from "./project-grants.js";
import { resolvePath } from "./resolve.js";
import type { Operation, ParsedRule } from "./rules.js";
import type { ProtectedIdentity } from "./self-protect.js";
import { isSelfProtected } from "./self-protect.js";
import { isDescendantOf } from "./walk.js";

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string; grantable: false }
  | { allowed: false; reason: string; grantable: true; resolvedPath: string; operation: Operation };

/**
 * Check a single path against self-protection, session denies, persistent
 * project grants, explicit session allows, global rules, and the baseline.
 *
 * Evaluation order: resolve → self-protect → session deny → persistent
 * project grant → explicit /ward allow → global rule evaluator → baseline
 * deny / prompt-created allow / call-scoped approval.
 *
 * Returns:
 * - `{ allowed: true }` — access permitted.
 * - `{ allowed: false; grantable: false }` — no interactive prompt (self-protection, session deny, explicit rule, or resolve error). An explicit rule deny may still be overridden by /ward allow.
 * - `{ allowed: false; grantable: true; resolvedPath; operation }` — baseline deny that the user can override interactively.
 */
export async function checkPath(
  toolName: string,
  inputPath: string,
  operation: Operation,
  rules: ParsedRule[],
  projectRoot: string,
  grants?: GrantStore,
  callScopedRoot?: string,
  protectedIdentities: ProtectedIdentity[] = [],
  projectGrants: ParsedGrant[] = [],
): Promise<GuardResult> {
  const resolved = await resolvePath(inputPath, projectRoot);

  if (resolved.denied) {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: ${resolved.denied}`,
      grantable: false,
    };
  }

  if (await isSelfProtected(resolved.nominalPath, resolved.path, operation, protectedIdentities)) {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: ward config file is ${operation}-protected`,
      grantable: false,
    };
  }

  // Session denies are hard temporary blocks: they override project grants,
  // session allows, rules, baseline allows, and call-scoped approvals.
  if (grants?.isDenied(resolved.path, operation)) {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: denied by user (session)`,
      grantable: false,
    };
  }

  // Project grants and explicit /ward allows override ordinary global rules
  // and the baseline; prompt-created allows only override baseline denies.
  if (matchesProjectGrants(projectGrants, resolved.path, operation)) {
    return { allowed: true };
  }
  if (grants?.isExplicitlyAllowed(resolved.path, operation)) {
    return { allowed: true };
  }

  const result = evaluate(rules, operation, resolved.path, projectRoot);

  if (result.effect === "allow") {
    return { allowed: true };
  }

  // Explicit rule denies do not trigger an interactive approval prompt.
  if (result.source === "rule") {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: denied by policy`,
      grantable: false,
    };
  }

  // Prompt-created session allows and call-scoped recursive approval (e.g. a
  // grep run against a prompt-approved directory) permit baseline-denied paths
  // only, after explicit rules have had the chance to win.
  if (grants?.isAllowed(resolved.path, operation)) {
    return { allowed: true };
  }
  if (callScopedRoot !== undefined && isDescendantOf(callScopedRoot, resolved.path)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: outside project root`,
    grantable: true,
    resolvedPath: resolved.path,
    operation,
  };
}

/**
 * Non-interactive guard: checks all paths and returns the first deny.
 * Does not prompt the user. Used for headless/non-UI contexts and testing.
 * For interactive approval, use `checkPath` in a loop with UI prompts (see index.ts).
 */
export async function guard(
  toolName: string,
  paths: string[],
  operation: Operation,
  rules: ParsedRule[],
  projectRoot: string,
  grants?: GrantStore,
  protectedIdentities: ProtectedIdentity[] = [],
  projectGrants: ParsedGrant[] = [],
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  for (const inputPath of paths) {
    const result = await checkPath(
      toolName,
      inputPath,
      operation,
      rules,
      projectRoot,
      grants,
      undefined,
      protectedIdentities,
      projectGrants,
    );
    if (!result.allowed) {
      return { allowed: false, reason: result.reason };
    }
  }
  return { allowed: true };
}
