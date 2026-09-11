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
 * project grants, rules, and the session grant store.
 *
 * Evaluation order: resolve → self-protect → session deny → persistent
 * project grant → global rule evaluator → baseline / session grant /
 * call-scoped approval.
 *
 * Returns:
 * - `{ allowed: true }` — access permitted.
 * - `{ allowed: false; grantable: false }` — hard deny (self-protection, session deny, explicit rule, or resolve error). No grant possible.
 * - `{ allowed: false; grantable: true; resolvedPath; operation }` — baseline deny that the user can override.
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

  // Session denies are hard temporary blocks: they override rule allows, baseline
  // allows, session grants, and call-scoped approvals. Checked before rule evaluation,
  // right after path resolution and self-protection.
  if (grants?.isDenied(resolved.path, operation)) {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: denied by user (session)`,
      grantable: false,
    };
  }

  // Persistent project grants are an explicit, trusted exception layer: they
  // may override an ordinary global deny rule, so they are checked before
  // rule evaluation. They are allow-only and never override self-protection
  // or session denies, both already checked above.
  if (matchesProjectGrants(projectGrants, resolved.path, operation)) {
    return { allowed: true };
  }

  const result = evaluate(rules, operation, resolved.path, projectRoot);

  if (result.effect === "allow") {
    return { allowed: true };
  }

  // Denied by explicit rule — not grantable.
  if (result.source === "rule") {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: denied by policy`,
      grantable: false,
    };
  }

  // Baseline deny — check session grants before declaring it grantable.
  if (grants?.isAllowed(resolved.path, operation)) {
    return { allowed: true };
  }

  // Call-scoped recursive approval (e.g. a grep run against a prompt-approved
  // directory): permits descendants of that root for this call only, after
  // explicit rules and session grants/denies have already had the chance to win.
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
