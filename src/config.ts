import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ParsedPattern } from "./pattern.js";
import { parsePattern } from "./pattern.js";
import { resolveRealPath } from "./resolve.js";
import type { ParsedRule, Rule } from "./rules.js";
import { WardConfigSchema } from "./schema.js";
import type { ProtectedIdentity } from "./self-protect.js";

export interface WardConfig {
  $schema?: string;
  rules: Rule[];
}

/** Absolute path to the global ward config file (`~/.pi/agent/ward.json`). */
export function globalConfigPath(): string {
  return join(getAgentDir(), "ward.json");
}

export interface LoadResult {
  /** Flat list of parsed global rules. */
  rules: ParsedRule[];
  /**
   * Identity (dev, ino) of the global config file, if it was successfully
   * loaded and is currently in effect. Used by self-protection to detect a
   * hardlink/symlink alias to an active config that doesn't structurally
   * look like one. Empty when no config file was found.
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
 * Parse validated rules into ParsedRules, attaching configDir and checking
 * for allow rules that can structurally never match within their scope.
 *
 * The global config's directory is the home directory (`homeDir`).
 *
 * Throws if:
 * - parsePattern throws (invalid syntax, including "./"-anchored patterns)
 * - An allow rule has a "~/"-home-anchored pattern starting with ".." (escapes home dir)
 */
export async function parseConfigRules(config: WardConfig, homeDir: string, filePath: string): Promise<ParsedRule[]> {
  const results: ParsedRule[] = [];
  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];
    let parsedPattern = parsePattern(rule.pattern);

    // Resolve absolute-anchored patterns to handle symlinks (e.g. macOS /tmp → /private/tmp).
    if (parsedPattern.absoluteAnchored) {
      parsedPattern = await resolveAbsolutePattern(parsedPattern);
    }

    // Load-time trust check: a "~/"-home-anchored allow pattern starting with
    // ".." can never match within the home directory.
    if (rule.effect === "allow" && parsedPattern.segments.length > 0) {
      const firstSeg = parsedPattern.segments[0];
      if (firstSeg.kind === "literal" && firstSeg.value === ".." && parsedPattern.homeAnchored) {
        throw new Error(
          `Config "${filePath}": rule[${i}]: allow rule with pattern "${rule.pattern}" ` +
            `can never match within the home directory "${homeDir}"`,
        );
      }
    }

    results.push({
      pattern: parsedPattern,
      rawPattern: rule.pattern,
      operations: rule.operations ?? "read",
      effect: rule.effect,
      configDir: parsedPattern.absoluteAnchored ? "/" : homeDir,
      homeDir,
    });
  }
  return results;
}

/**
 * Load the global ward config (`~/.pi/agent/ward.json`).
 *
 * A project-local `<project>/.pi/ward.json` is not loaded as declarative
 * policy — only the global config is. ENOENT on the global config file is
 * silently skipped. Any other error fails closed.
 */
export async function loadConfig(homeDir?: string): Promise<LoadResult> {
  const home = homeDir ?? homedir();
  const allRules: ParsedRule[] = [];
  const protectedIdentities: ProtectedIdentity[] = [];

  const globalPath = globalConfigPath();
  const globalConfig = await readConfigFile(globalPath);
  if (globalConfig !== null) {
    allRules.push(...(await parseConfigRules(globalConfig, home, globalPath)));
    protectedIdentities.push(await identityFor(globalPath));
  }

  return { rules: allRules, protectedIdentities };
}
