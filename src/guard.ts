import { evaluate } from "./evaluator.js";
import { resolvePath } from "./resolve.js";
import type { Operation, ParsedRule } from "./rules.js";
import { isSelfProtected } from "./self-protect.js";

/**
 * Guard a tool call's path(s) against the configured rules.
 *
 * Returns `{ allowed: true }` when every path passes, or
 * `{ allowed: false; reason: string }` with a formatted `[pi-ward] Blocked ...`
 * message on the first path that fails.
 */
export async function guard(
  _toolName: string,
  paths: string[],
  operation: Operation,
  rules: ParsedRule[],
  projectRoot: string,
  protectedPaths: string[],
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  for (const inputPath of paths) {
    const resolved = await resolvePath(inputPath, projectRoot);

    if (resolved.denied) {
      return {
        allowed: false,
        reason: `[pi-ward] Blocked ${operation} on ${inputPath}: ${resolved.denied}`,
      };
    }

    if (operation === "write" && isSelfProtected(resolved.path, protectedPaths)) {
      return {
        allowed: false,
        reason: `[pi-ward] Blocked ${operation} on ${inputPath}: Cannot modify ward config file: ${resolved.path}`,
      };
    }

    const effect = evaluate(rules, operation, resolved.path, projectRoot);
    if (effect === "deny") {
      return {
        allowed: false,
        reason: `[pi-ward] Blocked ${operation} on ${inputPath}: Access denied: ${operation} ${inputPath}`,
      };
    }
  }

  return { allowed: true };
}
