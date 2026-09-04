import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative } from "node:path";
import {
  globalConfigPath,
  parseConfigJson,
  parseConfigRules,
  readConfigFileRaw,
  validateConfig,
  type WardConfig,
} from "./config.js";
import { evaluate } from "./evaluator.js";
import { resolvePath } from "./resolve.js";
import type { Effect, Operation, ParsedRule, Rule } from "./rules.js";
import type { ProtectedIdentity } from "./self-protect.js";
import { isSelfProtected } from "./self-protect.js";
import { isDescendantOf } from "./walk.js";

// ---------------------------------------------------------------------------
// Candidate preparation
// ---------------------------------------------------------------------------

export interface PolicyCandidateInput {
  /** Raw literal path as typed by the caller. Must not contain glob characters. */
  rawPath: string;
  effect: Effect;
  operation: Operation;
  /** Active session's canonical (realpath-resolved) project root. */
  projectRoot: string;
  /** Override for the home directory. Defaults to os.homedir(). */
  homeDir?: string;
  /** Identities of currently-active config files, for self-protection aliasing checks. */
  protectedIdentities?: ProtectedIdentity[];
}

export interface PreparedCandidate {
  /** The literal pattern string that will be written to the global config. */
  pattern: string;
  operations: Operation;
  effect: Effect;
  /** Canonical project root this rule is conditioned on. */
  projectRoot: string;
  /** Resolved absolute (realpath) target path. */
  resolvedPath: string;
  /** Whether the candidate is a directory (trailing-slash intent). */
  directory: boolean;
  /** The Rule object ready to be appended to the global config's rules array. */
  rule: Rule;
}

/** Characters that indicate glob/wildcard intent — rejected for persistent literal rules. */
function containsGlob(inputPath: string): boolean {
  return /[*?]|\[|\]/.test(inputPath);
}

function toPatternBody(absPath: string): string {
  return absPath
    .split(/[/\\]/)
    .filter((s) => s !== "")
    .join("/");
}

/**
 * Spell a resolved absolute path in readable form: `~/`-relative when the
 * path is canonically within the home directory, otherwise absolute.
 *
 * This is the single source of truth for the home-containment check and
 * spelling used both for persisted pattern strings and for the persisted
 * `projectRoot` condition value.
 */
function toReadablePath(resolvedPath: string, homeDir: string): string {
  if (isDescendantOf(homeDir, resolvedPath)) {
    const rel = relative(homeDir, resolvedPath);
    const body = rel === "" ? "" : toPatternBody(rel);
    return body === "" ? "~/" : `~/${body}`;
  }

  const body = toPatternBody(resolvedPath);
  if (body === "") {
    throw new Error("Cannot build a readable path for the filesystem root");
  }
  return `/${body}`;
}

/**
 * Build a literal ward pattern string for a resolved absolute path.
 * Prefers `~/`-relative spelling when the path is canonically within the
 * home directory; otherwise falls back to an absolute-anchored pattern.
 */
function buildLiteralPattern(resolvedPath: string, homeDir: string, directory: boolean): string {
  const readable = toReadablePath(resolvedPath, homeDir);
  if (!directory || readable.endsWith("/")) return readable;
  return `${readable}/`;
}

/**
 * Prepare a literal-path policy candidate from user-facing inputs.
 *
 * Throws if:
 * - `rawPath` contains glob/wildcard characters.
 * - The path cannot be resolved.
 * - `operation` is "write" and the resolved target is a self-protected
 *   (ward config) path.
 */
export async function prepareCandidate(input: PolicyCandidateInput): Promise<PreparedCandidate> {
  const { rawPath, effect, operation, projectRoot } = input;
  const homeDir = input.homeDir ?? homedir();

  if (containsGlob(rawPath)) {
    throw new Error(`Glob patterns are not supported for persistent rules — use a literal path: "${rawPath}"`);
  }

  const directory = rawPath.endsWith("/");
  const resolved = await resolvePath(rawPath, projectRoot, homeDir);
  if (resolved.denied) {
    throw new Error(`Cannot resolve path "${rawPath}": ${resolved.denied}`);
  }

  if (
    operation === "write" &&
    (await isSelfProtected(resolved.nominalPath, resolved.path, input.protectedIdentities ?? []))
  ) {
    throw new Error(`Cannot persist write rule for "${rawPath}": ward config file is write-protected`);
  }

  const pattern = buildLiteralPattern(resolved.path, homeDir, directory);
  const readableProjectRoot = toReadablePath(projectRoot, homeDir);

  const rule: Rule = {
    pattern,
    operations: operation,
    effect,
    projectRoot: readableProjectRoot,
  };

  return {
    pattern,
    operations: operation,
    effect,
    projectRoot,
    resolvedPath: resolved.path,
    directory,
    rule,
  };
}

// ---------------------------------------------------------------------------
// Preflight — evaluate the candidate against a snapshot of the global config
// ---------------------------------------------------------------------------

export interface GlobalSnapshot {
  /** Exact raw bytes read from the global config file. Null when the file is absent. */
  raw: string | null;
  /** Parsed and validated global config (missing file treated as `{ rules: [] }`). */
  config: WardConfig;
  /** Parsed global rules. */
  globalRules: ParsedRule[];
}

export interface SupersededRule {
  pattern: string;
  configDir: string;
  effect: Effect;
}

export type PreflightResult = { ok: true; supersedes?: SupersededRule } | { ok: false; reason: string };

/** Read a fresh snapshot of the global config, treating a missing file as `{ rules: [] }`. */
export async function readGlobalSnapshot(homeDir: string): Promise<GlobalSnapshot> {
  const path = globalConfigPath();
  const raw = await readConfigFileRaw(path);
  const config: WardConfig = raw === null ? { rules: [] } : parseConfigJson(raw, path);
  const globalRules = await parseConfigRules(config, homeDir, path, homeDir, true);
  return { raw, config, globalRules };
}

/**
 * Evaluate a candidate rule as if it had actually been appended at the end of
 * the global config's rule list — its real append position (after all
 * existing global rules, before project rules) — against a fresh global
 * snapshot and the current project rules.
 *
 * Rejects when:
 * - An earlier global rule already matches this path+operation (the appended
 *   candidate would be shadowed and never take effect).
 * - The candidate is a persistent allow and the current effective policy
 *   (global + project) already has an explicit deny rule for this path.
 *
 * For a persistent deny candidate that would supersede a currently-matched
 * project rule, discloses that rule via `supersedes` (informational only,
 * not a rejection).
 */
export function evaluateCandidate(
  candidate: PreparedCandidate,
  globalRules: ParsedRule[],
  projectRules: ParsedRule[],
): PreflightResult {
  // The candidate is appended after all existing global rules — so first,
  // check whether an existing global rule already matches this path+operation.
  // If it does, first-match-wins means the appended candidate would never be
  // reached regardless of what it says.
  const earlierGlobal = evaluate(globalRules, candidate.operations, candidate.resolvedPath, candidate.projectRoot);
  if (earlierGlobal.source === "rule") {
    return {
      ok: false,
      reason:
        `Would be shadowed by an earlier global rule: pattern "${earlierGlobal.pattern}" ` +
        `(effect ${earlierGlobal.effect}, from ${earlierGlobal.configDir}) already matches this path — ` +
        `appending this rule would have no effect.`,
    };
  }

  if (candidate.effect === "allow") {
    const currentEffective = evaluate(
      [...globalRules, ...projectRules],
      candidate.operations,
      candidate.resolvedPath,
      candidate.projectRoot,
    );
    if (currentEffective.effect === "deny" && currentEffective.source === "rule") {
      return {
        ok: false,
        reason:
          `Cannot persist allow: an explicit deny rule ("${currentEffective.pattern}" from ` +
          `${currentEffective.configDir}) currently governs this path — persisting an allow would ` +
          `silently override it.`,
      };
    }
  }

  let supersedes: SupersededRule | undefined;
  if (candidate.effect === "deny") {
    const projectOnly = evaluate(projectRules, candidate.operations, candidate.resolvedPath, candidate.projectRoot);
    if (projectOnly.source === "rule") {
      supersedes = { pattern: projectOnly.pattern, configDir: projectOnly.configDir, effect: projectOnly.effect };
    }
  }

  return supersedes === undefined ? { ok: true } : { ok: true, supersedes };
}

/** Read a fresh global snapshot and evaluate the candidate against it. */
export async function preflightCandidate(
  candidate: PreparedCandidate,
  projectRules: ParsedRule[],
  homeDir: string,
): Promise<{ snapshot: GlobalSnapshot; result: PreflightResult }> {
  const snapshot = await readGlobalSnapshot(homeDir);
  const result = evaluateCandidate(candidate, snapshot.globalRules, projectRules);
  return { snapshot, result };
}

// ---------------------------------------------------------------------------
// Persist — append-only, locked, atomic write
// ---------------------------------------------------------------------------

export type PersistResult = { ok: true } | { ok: false; reason: string };

export interface PersistParams {
  candidate: PreparedCandidate;
  /** Raw bytes of the global config as read during preflight (`snapshot.raw`). */
  previousRaw: string | null;
  /** Current project-level parsed rules (unaffected by this persist). */
  projectRules: ParsedRule[];
  homeDir: string;
}

/**
 * Persist a previously-approved candidate to the global config.
 *
 * Acquires a cooperative, fail-fast exclusive lock (a sibling `.lock` file
 * created with O_CREAT|O_EXCL). Under the lock:
 * - Re-reads and revalidates the global config.
 * - Aborts if its raw bytes differ from what was read during preparation.
 * - Re-runs the preflight checks against the fresh snapshot.
 * - Appends the rule (append-only — no other rules are touched) and
 *   validates the complete resulting config against the schema.
 * - Writes a same-directory temp file and atomically renames it into place,
 *   preserving the existing file's permission mode (or 0600 for a new file).
 *
 * Cleans up the temp file and the lock file on any handled failure. A
 * crash-stale lock file is not detected or recovered automatically — it
 * requires manual removal.
 */
export async function persistCandidate(params: PersistParams): Promise<PersistResult> {
  const { candidate, previousRaw, projectRules, homeDir } = params;
  const path = globalConfigPath();
  const lockPath = `${path}.lock`;

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (err) {
    return { ok: false, reason: `Cannot persist: failed to create config directory: ${(err as Error).message}` };
  }

  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      return {
        ok: false,
        reason: "Cannot persist: another ward policy write is already in progress (lock file exists).",
      };
    }
    return { ok: false, reason: `Cannot persist: failed to acquire lock: ${(err as Error).message}` };
  }

  let tmpPath: string | undefined;
  let tmpHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const raw = await readConfigFileRaw(path);
    if (raw !== previousRaw) {
      return {
        ok: false,
        reason: "Aborted: the global config changed since this proposal was prepared. Please retry.",
      };
    }

    const rawConfig: WardConfig = raw === null ? { rules: [] } : parseConfigJson(raw, path);
    const globalRules = await parseConfigRules(rawConfig, homeDir, path, homeDir, true);

    const preflight = evaluateCandidate(candidate, globalRules, projectRules);
    if (!preflight.ok) {
      return { ok: false, reason: preflight.reason };
    }

    const newConfig: WardConfig = { ...rawConfig, rules: [...rawConfig.rules, candidate.rule] };

    try {
      validateConfig(newConfig, path);
      await parseConfigRules(newConfig, homeDir, path, homeDir, true);
    } catch (err) {
      return { ok: false, reason: `Resulting config would be invalid: ${(err as Error).message}` };
    }

    let mode = 0o600;
    if (raw !== null) {
      const st = await stat(path);
      mode = st.mode & 0o777;
    }

    tmpPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    tmpHandle = await open(tmpPath, "wx", mode);
    await tmpHandle.writeFile(`${JSON.stringify(newConfig, null, 2)}\n`, "utf-8");
    await tmpHandle.close();
    tmpHandle = undefined;
    await rename(tmpPath, path);
    tmpPath = undefined;

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    if (tmpHandle !== undefined) {
      await tmpHandle.close().catch(() => {});
    }
    if (tmpPath !== undefined) {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
    await lockHandle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * List currently-persisted global rules whose `projectRoot` condition
 * includes the active (canonical) project root.
 */
export async function listProjectRules(projectRoot: string, homeDir: string): Promise<ParsedRule[]> {
  const snapshot = await readGlobalSnapshot(homeDir);
  return snapshot.globalRules.filter((r) => r.projectRoots?.includes(projectRoot));
}
