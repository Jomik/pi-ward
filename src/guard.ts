import { sep } from "node:path";
import { evaluate } from "./evaluator.js";
import type { GrantStore } from "./grants.js";
import { resolvePath } from "./resolve.js";
import type { Operation, ParsedRule } from "./rules.js";
import { isSelfProtected } from "./self-protect.js";

/** True if `path` is `root` itself or a descendant of `root`. */
function isWithinRoot(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix);
}

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string; grantable: false }
  | { allowed: false; reason: string; grantable: true; resolvedPath: string; operation: Operation };

/**
 * Check a single path against rules, self-protection, and the grant store.
 *
 * Returns:
 * - `{ allowed: true }` — access permitted.
 * - `{ allowed: false; grantable: false }` — hard deny (explicit rule or resolve error). No grant possible.
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
): Promise<GuardResult> {
  const resolved = await resolvePath(inputPath, projectRoot);

  if (resolved.denied) {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: ${resolved.denied}`,
      grantable: false,
    };
  }

  if (operation === "write" && isSelfProtected(resolved.path)) {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (write) on ${inputPath}: ward config file is write-protected`,
      grantable: false,
    };
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

  if (grants?.isDenied(resolved.path, operation)) {
    return {
      allowed: false,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: denied by user (session)`,
      grantable: false,
    };
  }

  // Call-scoped recursive approval (e.g. a grep run against a prompt-approved
  // directory): permits descendants of that root for this call only, after
  // explicit rules and session grants/denies have already had the chance to win.
  if (callScopedRoot !== undefined && isWithinRoot(resolved.path, callScopedRoot)) {
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
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  for (const inputPath of paths) {
    const result = await checkPath(toolName, inputPath, operation, rules, projectRoot, grants);
    if (!result.allowed) {
      return { allowed: false, reason: result.reason };
    }
  }
  return { allowed: true };
}
