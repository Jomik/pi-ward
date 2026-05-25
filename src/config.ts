import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { parsePattern } from "./pattern.js";
import type { ParsedRule, Rule } from "./rules.js";
import { WardConfigSchema } from "./schema.js";
import { ancestorDirs } from "./walk.js";

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
 * Parse validated rules into ParsedRules, attaching configDir and checking
 * for allow rules that can structurally never match within their scope.
 *
 * Throws if:
 * - parsePattern throws (invalid syntax)
 * - An allow rule has a "./"-anchored pattern starting with ".." (escapes config dir)
 * - An allow rule has a "~/"-home-anchored pattern starting with ".." (escapes home dir)
 * - isGlobal is true and a rule uses a "./"-anchored pattern
 */
function parseConfigRules(
  config: WardConfig,
  configDir: string,
  filePath: string,
  homeDir: string,
  isGlobal = false,
): ParsedRule[] {
  return config.rules.map((rule, i) => {
    const parsedPattern = parsePattern(rule.pattern);

    // Global config disallows "./"-anchored patterns (no sensible "current directory").
    if (isGlobal && parsedPattern.anchored) {
      throw new Error(
        `Config "${filePath}": rule[${i}]: "./"-anchored pattern "${rule.pattern}" is not allowed in the global config. ` +
          `Use "~/" for home-relative paths or unanchored patterns.`,
      );
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

    return {
      pattern: parsedPattern,
      operations: rule.operations ?? "read",
      effect: rule.effect,
      configDir,
      homeDir,
    };
  });
}

/**
 * Load all ward configs for a given project root.
 *
 * Walk order (global first, project last):
 * 1. `~/.pi/agent/ward.json` — global config, configDir = homedir
 * 2. `<dir>/.pi/ward.json` for each ancestor from homedir toward projectRoot
 * 3. `projectRoot/.pi/ward.json` — project config, configDir = projectRoot
 *
 * If projectRoot is outside homedir, only the global config is loaded.
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
    allRules.push(...parseConfigRules(globalConfig, home, globalConfigPath, home, true));
  }

  // Steps 2+3: walk ancestor directories from home to projectRoot (inclusive).
  // ancestorDirs returns [] when projectRoot is outside home, so this is a no-op in that case.
  const dirs = ancestorDirs(home, projectRoot);
  for (const dir of dirs) {
    const configPath = join(dir, ".pi", "ward.json");
    const config = await readConfigFile(configPath);
    if (config !== null) {
      allRules.push(...parseConfigRules(config, dir, configPath, home));
    }
  }

  return { rules: allRules };
}
