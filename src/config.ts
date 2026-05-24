import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parsePattern } from "./pattern.js";
import type { ParsedRule, Rule } from "./rules.js";
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
 * Validate the raw parsed JSON against the expected WardConfig schema.
 * Throws with a descriptive message (including file path) on any schema violation.
 */
function validateConfig(raw: unknown, filePath: string): WardConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Config "${filePath}": must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.rules)) {
    throw new Error(`Config "${filePath}": missing or invalid "rules" array`);
  }

  const rules = obj.rules.map((ruleRaw: unknown, i: number) => validateRule(ruleRaw, i, filePath));
  return { rules };
}

function validateOperations(operations: unknown, index: number, filePath: string): ("read" | "write")[] {
  if (!Array.isArray(operations)) {
    throw new Error(`Config "${filePath}": rule[${index}].operations must be an array`);
  }
  for (const op of operations) {
    if (op !== "read" && op !== "write") {
      throw new Error(`Config "${filePath}": rule[${index}].operations contains invalid value "${String(op)}"`);
    }
  }
  return operations as ("read" | "write")[];
}

function validateRule(ruleRaw: unknown, index: number, filePath: string): Rule {
  if (typeof ruleRaw !== "object" || ruleRaw === null || Array.isArray(ruleRaw)) {
    throw new Error(`Config "${filePath}": rule[${index}] must be an object`);
  }
  const r = ruleRaw as Record<string, unknown>;

  if (typeof r.pattern !== "string") {
    throw new Error(`Config "${filePath}": rule[${index}].pattern must be a string`);
  }
  if (r.effect !== "allow" && r.effect !== "deny") {
    throw new Error(`Config "${filePath}": rule[${index}].effect must be "allow" or "deny"`);
  }

  let operations: ("read" | "write")[] | undefined;
  if (r.operations !== undefined) {
    operations = validateOperations(r.operations, index, filePath);
  }

  return {
    pattern: r.pattern,
    effect: r.effect,
    ...(operations !== undefined ? { operations } : {}),
  };
}

/**
 * Parse validated rules into ParsedRules, attaching configDir and checking
 * for allow rules that can structurally never match within the config's directory.
 *
 * Throws if:
 * - parsePattern throws (invalid syntax)
 * - An allow rule has an anchored pattern whose first segment is ".." (escapes config dir)
 */
function parseConfigRules(config: WardConfig, configDir: string, filePath: string): ParsedRule[] {
  return config.rules.map((rule, i) => {
    const parsedPattern = parsePattern(rule.pattern);

    // Load-time trust check: an anchored allow pattern starting with ".." can never
    // match within the config's directory.
    if (rule.effect === "allow" && parsedPattern.anchored && parsedPattern.segments.length > 0) {
      const firstSeg = parsedPattern.segments[0];
      if (firstSeg.kind === "literal" && firstSeg.value === "..") {
        throw new Error(
          `Config "${filePath}": rule[${i}]: allow rule with pattern "${rule.pattern}" ` +
            `can never match within the config directory "${configDir}"`,
        );
      }
    }

    return {
      pattern: parsedPattern,
      operations: rule.operations ?? ["read", "write"],
      effect: rule.effect,
      configDir,
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
    allRules.push(...parseConfigRules(globalConfig, home, globalConfigPath));
  }

  // Steps 2+3: walk ancestor directories from home to projectRoot (inclusive).
  // ancestorDirs returns [] when projectRoot is outside home, so this is a no-op in that case.
  const dirs = ancestorDirs(home, projectRoot);
  for (const dir of dirs) {
    const configPath = join(dir, ".pi", "ward.json");
    const config = await readConfigFile(configPath);
    if (config !== null) {
      allRules.push(...parseConfigRules(config, dir, configPath));
    }
  }

  return { rules: allRules };
}
