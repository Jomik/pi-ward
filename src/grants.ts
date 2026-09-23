import { operationCovers } from "./evaluator.js";
import type { ParsedGrant } from "./project-grants.js";
import type { Operation } from "./rules.js";
import { isDescendantOf } from "./walk.js";

export interface Decision {
  /** Resolved absolute path. */
  path: string;
  /** Operation level: "write" covers both read and write. */
  operation: Operation;
  /** If true, covers the path itself and everything under it. */
  directory: boolean;
}

/**
 * Match a list of `Decision`-shaped entries against an absolute path for a
 * given operation and effect, using the same semantics as `GrantStore`
 * ("write implies read" via `operationCovers`, exact-file vs.
 * recursive-directory matching). Shared so persistent project grants reuse
 * exactly the same matching logic as session grants, rather than a second
 * matcher abstraction.
 */
export function matchDecisions(
  decisions: Decision[],
  absolutePath: string,
  operation: Operation,
  effect: "allow" | "deny",
): boolean {
  for (const decision of decisions) {
    if (!operationCovers(effect, decision.operation, operation)) continue;
    const matches = decision.directory ? isDescendantOf(decision.path, absolutePath) : decision.path === absolutePath;
    if (matches) return true;
  }
  return false;
}

/**
 * Check whether a resolved absolute path is covered by an active project's
 * persistent grants (always allow-only). Reuses `matchDecisions` by mapping
 * each `ParsedGrant` to the same `Decision` shape used for session grants.
 */
export function matchesProjectGrants(grants: ParsedGrant[], absolutePath: string, operation: Operation): boolean {
  const decisions: Decision[] = grants.map((g) => ({
    path: g.resolvedPath,
    operation: g.operations,
    directory: g.directory,
  }));
  return matchDecisions(decisions, absolutePath, operation, "allow");
}

/**
 * In-memory store for runtime access decisions made by the user.
 *
 * Explicit /ward allows override ordinary global denies and the baseline;
 * prompt-created allows override baseline denies only. Neither overrides
 * self-protection or session denies. Rule denies do not trigger prompts.
 *
 * Session denies are hard temporary blocks: they override session allows,
 * persistent project grants, rule and baseline allows, and call-scoped
 * approvals for the remainder of the process.
 */
export class GrantStore {
  private allows: Decision[] = [];
  private explicitAllows: Decision[] = [];
  private denies: Decision[] = [];

  addAllow(path: string, operation: Operation, directory: boolean, explicit = false): void {
    const decision = { path, operation, directory };
    this.allows.push(decision);
    if (explicit) this.explicitAllows.push(decision);
  }

  addDeny(path: string, operation: Operation, directory: boolean): void {
    this.denies.push({ path, operation, directory });
  }

  isAllowed(absolutePath: string, operation: Operation): boolean {
    return matchDecisions(this.allows, absolutePath, operation, "allow");
  }

  isExplicitlyAllowed(absolutePath: string, operation: Operation): boolean {
    return matchDecisions(this.explicitAllows, absolutePath, operation, "allow");
  }

  isDenied(absolutePath: string, operation: Operation): boolean {
    return matchDecisions(this.denies, absolutePath, operation, "deny");
  }

  /** Return a copy of current session allows (for inspection/testing). */
  listAllows(): Decision[] {
    return [...this.allows];
  }

  /** Return a copy of current session denies (for inspection/testing). */
  listDenies(): Decision[] {
    return [...this.denies];
  }

  /**
   * Remove any allow or deny decision that matches `absolutePath` exactly.
   * Returns true if at least one entry was removed.
   */
  revoke(absolutePath: string): boolean {
    const beforeAllows = this.allows.length;
    const beforeDenies = this.denies.length;
    this.allows = this.allows.filter((d) => d.path !== absolutePath);
    this.explicitAllows = this.explicitAllows.filter((d) => d.path !== absolutePath);
    this.denies = this.denies.filter((d) => d.path !== absolutePath);
    return this.allows.length < beforeAllows || this.denies.length < beforeDenies;
  }

  /** Remove all decisions (for testing). */
  clear(): void {
    this.allows = [];
    this.explicitAllows = [];
    this.denies = [];
  }
}
