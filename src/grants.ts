import { operationCovers } from "./evaluator.js";
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
 * In-memory store for runtime access decisions made by the user.
 *
 * Session grants override baseline denies (paths outside project root that have
 * no explicit deny rule). They cannot override explicit deny rules.
 *
 * Session denies suppress future prompts for the same path — the user won't
 * be asked again for the remainder of the process.
 */
export class GrantStore {
  private allows: Decision[] = [];
  private denies: Decision[] = [];

  addAllow(path: string, operation: Operation, directory: boolean): void {
    this.allows.push({ path, operation, directory });
  }

  addDeny(path: string, operation: Operation, directory: boolean): void {
    this.denies.push({ path, operation, directory });
  }

  isAllowed(absolutePath: string, operation: Operation): boolean {
    return this.matchDecisions(this.allows, absolutePath, operation, "allow");
  }

  isDenied(absolutePath: string, operation: Operation): boolean {
    return this.matchDecisions(this.denies, absolutePath, operation, "deny");
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
    this.denies = this.denies.filter((d) => d.path !== absolutePath);
    return this.allows.length < beforeAllows || this.denies.length < beforeDenies;
  }

  /** Remove all decisions (for testing). */
  clear(): void {
    this.allows = [];
    this.denies = [];
  }

  private matchDecisions(
    decisions: Decision[],
    absolutePath: string,
    operation: Operation,
    effect: "allow" | "deny",
  ): boolean {
    for (const decision of decisions) {
      if (!operationCovers(effect, decision.operation, operation)) continue;
      if (this.pathMatches(decision, absolutePath)) return true;
    }
    return false;
  }

  private pathMatches(decision: Decision, absolutePath: string): boolean {
    return decision.directory ? isDescendantOf(decision.path, absolutePath) : decision.path === absolutePath;
  }
}
