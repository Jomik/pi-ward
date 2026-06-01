import type { ParsedPattern } from "./pattern.js";

export type Operation = "read" | "write";
export type Effect = "allow" | "deny";

export interface Rule {
  pattern: string;
  operations?: Operation;
  effect: Effect;
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
}
