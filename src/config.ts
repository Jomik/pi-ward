import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ParsedPattern } from "./pattern.js";
import { parsePattern } from "./pattern.js";
import { resolveRealPath } from "./resolve.js";
import type { ParsedRule, Rule } from "./rules.js";
import { WardConfigSchema } from "./schema.js";
import type { ProtectedIdentity } from "./self-protect.js";
import { isDescendantOf } from "./walk.js";

export interface WardConfig {
  $schema?: string;
  rules: Rule[];
}

/** Absolute path to the global ward config file (`~/.pi/agent/ward.json`). */
export function globalConfigPath(): string {
  return join(getAgentDir(), "ward.json");
}

export interface LoadResult {
  /** Flat list of parsed rules, global first, project last. */
  rules: ParsedRule[];
  /**
   * Identity (dev, ino) of every config file that was successfully loaded and
   * is currently in effect (global and/or project). Used by self-protection
   * to detect a hardlink/symlink alias to an active config that doesn't
   * structurally look like one. Empty when no config file was found.
   */
  protectedIdentities: ProtectedIdentity[];
}

/**
 * Compute the on-disk identity (dev, ino) of a config file that was just
 * successfully loaded. Resolves through symlinks first so aliasing via a
 * symlinked ancestor still resolves to the same identity as the real file.
 */
export async function identityFor(filePath: string): Promise<ProtectedIdentity> {
  const real = (await resolveRealPath(filePath)) ?? filePath;
  const st = await stat(real);
  return { dev: st.dev, ino: st.ino };
}

/**
 * Read the raw text content of a config file.
 * Returns null on ENOENT. Throws on EACCES or other read errors.
 */
export async function readConfigFileRaw(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new Error(`Cannot read config file "${filePath}": ${(err as Error).message}`);
  }
}

/**
 * Parse raw config file text as JSON and validate it against WardConfigSchema.
 * Throws with a descriptive message (including file path) on invalid JSON or
 * any schema violation.
 */
export function parseConfigJson(raw: string, filePath: string): WardConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file "${filePath}": ${(err as Error).message}`);
  }

  return validateConfig(parsed, filePath);
}

/**
 * Read and JSON-parse a config file.
 * Returns null on ENOENT. Throws on EACCES or other read errors.
 * Throws on invalid JSON.
 */
async function readConfigFile(filePath: string): Promise<WardConfig | null> {
  const content = await readConfigFileRaw(filePath);
  if (content === null) return null;
  return parseConfigJson(content, filePath);
}

/**
 * Validate the raw parsed JSON against WardConfigSchema.
 * Throws with a descriptive message (including file path) on any schema violation.
 * Returns the validated object as-is (preserving any extra properties such as
 * `$schema`) so round-tripping writers don't need to reconstruct it.
 */
export function validateConfig(raw: unknown, filePath: string): WardConfig {
  if (!Value.Check(WardConfigSchema, raw)) {
    const errors = Value.Errors(WardConfigSchema, raw);
    const first = errors[0];
    if (first === undefined) {
      throw new Error(`Config "${filePath}": schema validation failed`);
    }
    throw new Error(`Config "${filePath}": ${first.instancePath}: ${first.message}`);
  }
  return raw;
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
 * Normalize and resolve a projectRoot condition value from a rule.
 *
 * - Supports `~/`-prefixed home-relative paths and absolute paths.
 * - Relative paths (no `~/` and not absolute) are a load-time error.
 * - Trailing slashes are stripped so the result compares cleanly against
 *   the session's resolved projectRoot (which has no trailing slash).
 * - Symlinks are resolved at load time via `resolveRealPath`.
 * - ENOENT: the normalized path is stored as-is. It will never match a real
 *   (realpath-resolved) project root, so the rule condition is effectively
 *   unsatisfiable — fail-closed for allow rules, but also fail-closed for
 *   deny rules (the deny condition simply never triggers).
 * - Non-ENOENT errors (EACCES, ELOOP, …): fail closed at load time.
 */
async function resolveProjectRootValue(
  value: string,
  homeDir: string,
  filePath: string,
  ruleIdx: number,
): Promise<string> {
  let normalized: string;
  if (value.startsWith("~/")) {
    normalized = resolve(homeDir, value.slice(2));
  } else if (isAbsolute(value)) {
    normalized = resolve(value);
  } else {
    throw new Error(
      `Config "${filePath}": rule[${ruleIdx}]: projectRoot "${value}" must be an absolute path or start with "~/".`,
    );
  }

  // Resolve symlinks. Nonexistent paths resolve via ancestor walk-up (see resolveRealPath).
  let real: string | null;
  try {
    real = await resolveRealPath(normalized);
  } catch (err) {
    throw new Error(
      `Config "${filePath}": rule[${ruleIdx}]: cannot resolve projectRoot "${value}": ${(err as Error).message}`,
    );
  }
  // null means no existing ancestor was found — store the normalized form.
  return real ?? normalized;
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
 * - isGlobal is false and a rule uses `projectRoot`
 * - A `projectRoot` value is not absolute and does not start with `~/`
 */
export async function parseConfigRules(
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

    // projectRoot condition: only allowed in global config.
    if (rule.projectRoot !== undefined && !isGlobal) {
      throw new Error(
        `Config "${filePath}": rule[${i}]: "projectRoot" is only allowed in the global config (~/.pi/agent/ward.json). ` +
          `Project configs cannot use "projectRoot".`,
      );
    }

    let projectRoots: string[] | undefined;
    if (rule.projectRoot !== undefined) {
      const rawRoots = Array.isArray(rule.projectRoot) ? rule.projectRoot : [rule.projectRoot];
      projectRoots = await Promise.all(rawRoots.map((v) => resolveProjectRootValue(v, homeDir, filePath, i)));
    }

    results.push({
      pattern: parsedPattern,
      rawPattern: rule.pattern,
      operations: rule.operations ?? "read",
      effect: rule.effect,
      configDir: parsedPattern.absoluteAnchored ? "/" : configDir,
      homeDir,
      ...(projectRoots !== undefined && { projectRoots }),
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
  const protectedIdentities: ProtectedIdentity[] = [];

  // Step 1: global config — always attempted
  const globalPath = globalConfigPath();
  const globalConfig = await readConfigFile(globalPath);
  if (globalConfig !== null) {
    allRules.push(...(await parseConfigRules(globalConfig, home, globalPath, home, true)));
    protectedIdentities.push(await identityFor(globalPath));
  }

  // Step 2: project config
  const projectConfigPath = join(projectRoot, ".pi", "ward.json");
  const projectConfig = await readConfigFile(projectConfigPath);
  if (projectConfig !== null) {
    allRules.push(...(await parseConfigRules(projectConfig, projectRoot, projectConfigPath, home)));
    protectedIdentities.push(await identityFor(projectConfigPath));
  }

  return { rules: allRules, protectedIdentities };
}
