import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ParsedPattern } from "./pattern.js";
import { parsePattern } from "./pattern.js";
import { resolveRealPath } from "./resolve.js";
import type { ParsedRule, Rule } from "./rules.js";
import { WardConfigSchema } from "./schema.js";
import { isDescendantOf } from "./walk.js";

export interface WardConfig {
  rules: Rule[];
}

export interface LoadResult {
  /** Flat list of parsed rules, global first, project last. */
  rules: ParsedRule[];
}

/**
 * Read and JSON-parse a config file.
 * Returns null on ENOENT. Throws on EACCES or other read errors.
 * Throws on invalid JSON.
 */
async function readConfigFile(filePath: string): Promise<WardConfig | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new Error(`Cannot read config file "${filePath}": ${(err as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in config file "${filePath}": ${(err as Error).message}`);
  }

  return validateConfig(raw, filePath);
}

/**
 * Validate the raw parsed JSON against WardConfigSchema.
 * Throws with a descriptive message (including file path) on any schema violation.
 */
function validateConfig(raw: unknown, filePath: string): WardConfig {
  if (!Value.Check(WardConfigSchema, raw)) {
    const errors = Value.Errors(WardConfigSchema, raw);
    const first = errors[0];
    if (first === undefined) {
      throw new Error(`Config "${filePath}": schema validation failed`);
    }
    throw new Error(`Config "${filePath}": ${first.instancePath}: ${first.message}`);
  }
  return { rules: raw.rules };
}

/**
 * Resolve the leading literal segments of an absolute-anchored pattern via realpath.
 * This handles symlinks like macOS /tmp → /private/tmp.
 *
 * Strategy: find the longest leading literal prefix, resolve it, then re-derive segments.
 * If the prefix can't be resolved, the pattern is left unchanged — it may fail to match
 * symlink-resolved access paths but is otherwise harmless.
 */
async function resolveAbsolutePattern(pattern: ParsedPattern): Promise<ParsedPattern> {
  // Extract leading literal segments (stop at first wildcard/glob).
  const leadingLiterals: string[] = [];
  for (const seg of pattern.segments) {
    if (seg.kind !== "literal") break;
    leadingLiterals.push(seg.value);
  }

  if (leadingLiterals.length === 0) return pattern;

  const literalPath = join("/", ...leadingLiterals);
  let resolvedPath: string | null;
  try {
    resolvedPath = await resolveRealPath(literalPath);
  } catch {
    // EACCES/ELOOP etc. — leave pattern as-is. It may fail to match
    // symlink-resolved access paths but can still match in non-symlink cases.
    return pattern;
  }
  if (resolvedPath === null) return pattern;

  // Re-derive segments from the resolved path + any trailing non-literal segments.
  const resolvedSegments = resolvedPath.split(/[/\\]/).filter((s) => s !== "");
  const trailingSegments = pattern.segments.slice(leadingLiterals.length);
  const newSegments = [
    ...resolvedSegments.map((s): { kind: "literal"; value: string } => ({ kind: "literal", value: s })),
    ...trailingSegments,
  ];

  return { ...pattern, segments: newSegments };
}

/**
 * Parse validated rules into ParsedRules, attaching configDir and checking
 * for allow rules that can structurally never match within their scope.
 *
 * Throws if:
 * - parsePattern throws (invalid syntax)
 * - An allow rule has a "./"-anchored pattern starting with ".." (escapes config dir)
 * - An allow rule has a "~/"-home-anchored pattern starting with ".." (escapes home dir)
 * - isGlobal is true and a rule uses a "./"-anchored pattern
 * - isGlobal is false and a rule uses an absolute-anchored pattern
 */
async function parseConfigRules(
  config: WardConfig,
  configDir: string,
  filePath: string,
  homeDir: string,
  isGlobal = false,
): Promise<ParsedRule[]> {
  const results: ParsedRule[] = [];
  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];
    let parsedPattern = parsePattern(rule.pattern);

    // Global config disallows "./"-anchored patterns (no sensible "current directory").
    if (isGlobal && parsedPattern.anchored) {
      throw new Error(
        `Config "${filePath}": rule[${i}]: "./"-anchored pattern "${rule.pattern}" is not allowed in the global config. ` +
          `Use "~/" for home-relative paths or unanchored patterns.`,
      );
    }

    // Non-global configs disallow absolute-anchored patterns.
    if (!isGlobal && parsedPattern.absoluteAnchored) {
      throw new Error(
        `Config "${filePath}": rule[${i}]: absolute-path pattern "${rule.pattern}" is only allowed in the global config.`,
      );
    }

    // Resolve absolute-anchored patterns to handle symlinks (e.g. macOS /tmp → /private/tmp).
    if (parsedPattern.absoluteAnchored) {
      parsedPattern = await resolveAbsolutePattern(parsedPattern);
    }

    // Load-time trust check: a "./"-anchored or "~/"-home-anchored allow pattern
    // starting with ".." can never match within its respective scope.
    if (rule.effect === "allow" && parsedPattern.segments.length > 0) {
      const firstSeg = parsedPattern.segments[0];
      if (firstSeg.kind === "literal" && firstSeg.value === "..") {
        if (parsedPattern.anchored) {
          throw new Error(
            `Config "${filePath}": rule[${i}]: allow rule with pattern "${rule.pattern}" ` +
              `can never match within the config directory "${configDir}"`,
          );
        }
        if (parsedPattern.homeAnchored) {
          throw new Error(
            `Config "${filePath}": rule[${i}]: allow rule with pattern "${rule.pattern}" ` +
              `can never match within the home directory "${homeDir}"`,
          );
        }
      }
    }

    // Load-time trust check: a "~/"-home-anchored allow rule in a non-global config
    // can never fire if its resolved prefix has no overlap with configDir.
    if (rule.effect === "allow" && parsedPattern.homeAnchored && !isGlobal) {
      // Extract leading literal segments (stop at first wildcard/glob).
      const leadingLiterals: string[] = [];
      for (const seg of parsedPattern.segments) {
        if (seg.kind !== "literal") break;
        leadingLiterals.push(seg.value);
      }
      const effectiveRoot = join(homeDir, ...leadingLiterals);

      // Check if there's any possible overlap between matched paths and configDir.
      // Valid if configDir is within effectiveRoot OR effectiveRoot is within configDir.
      if (!isDescendantOf(effectiveRoot, configDir) && !isDescendantOf(configDir, effectiveRoot)) {
        throw new Error(
          `Config "${filePath}": rule[${i}]: allow rule with pattern "${rule.pattern}" ` +
            `can never match within the config directory "${configDir}" (trust scoping restricts ` +
            `allow rules to paths within their config's directory)`,
        );
      }
    }

    results.push({
      pattern: parsedPattern,
      rawPattern: rule.pattern,
      operations: rule.operations ?? "read",
      effect: rule.effect,
      configDir: parsedPattern.absoluteAnchored ? "/" : configDir,
      homeDir,
    });
  }
  return results;
}

/**
 * Load ward configs for a given project root.
 *
 * Load order (global first, project last):
 * 1. `~/.pi/agent/ward.json` — global config, configDir = homedir
 * 2. `<projectRoot>/.pi/ward.json` — project config, configDir = projectRoot
 *
 * ENOENT on any config file is silently skipped. Any other error fails closed.
 */
export async function loadConfig(projectRoot: string, homeDir?: string): Promise<LoadResult> {
  const home = homeDir ?? homedir();
  const allRules: ParsedRule[] = [];

  // Step 1: global config — always attempted
  const globalConfigPath = join(getAgentDir(), "ward.json");
  const globalConfig = await readConfigFile(globalConfigPath);
  if (globalConfig !== null) {
    allRules.push(...(await parseConfigRules(globalConfig, home, globalConfigPath, home, true)));
  }

  // Step 2: project config
  const projectConfigPath = join(projectRoot, ".pi", "ward.json");
  const projectConfig = await readConfigFile(projectConfigPath);
  if (projectConfig !== null) {
    allRules.push(...(await parseConfigRules(projectConfig, projectRoot, projectConfigPath, home)));
  }

  return { rules: allRules };
}
