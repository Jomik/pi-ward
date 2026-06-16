import type { ParsedPattern } from "./pattern.js";

export type Operation = "read" | "write";
export type Effect = "allow" | "deny";

export interface Rule {
  pattern: string;
  operations?: Operation;
  effect: Effect;
  /**
   * Optional project-root condition. Only valid in the global config.
   * When set, the rule only applies when the active session's project root
   * exactly matches this path (or any path in the array).
   * Supports absolute paths and `~/`-prefixed home-relative paths.
   */
  projectRoot?: string | string[];
}

export interface ParsedRule {
  pattern: ParsedPattern;
  /** The raw pattern string as it appeared in the config file. */
  rawPattern: string;
  /** Always explicit — defaulted to "read" when omitted on the raw rule. */
  operations: Operation;
  effect: Effect;
  /** Absolute path to the directory this rule's config governs. */
  configDir: string;
  /** Absolute path to the user's home directory (used for home-anchored patterns). */
  homeDir: string;
  /**
   * Resolved absolute paths for project-root conditions.
   * When set, the rule only applies when the session's project root exactly
   * matches one of these paths. `undefined` means no condition — the rule
   * applies regardless of project root.
   *
   * Paths are resolved at config load time (symlinks expanded, `~/` expanded).
   * A nonexistent path is stored as its normalized form and will simply never
   * match a real project root (fail-closed: allow rules won't fire, deny rules
   * won't fire either — the condition cannot be satisfied).
   */
  projectRoots?: string[];
}
