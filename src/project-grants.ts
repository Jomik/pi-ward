import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { identityFor } from "./config.js";
import { isDirectory } from "./fs-utils.js";
import { resolvePath, resolveRealPath } from "./resolve.js";
import type { Operation } from "./rules.js";
import type { ProtectedIdentity } from "./self-protect.js";
import { isSelfProtected } from "./self-protect.js";
import { isDescendantOf } from "./walk.js";

/** Canonical UUID syntax: lowercase, hyphenated, no braces/urn prefix. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A UUID (36 chars) plus an optional trailing newline is 37 bytes. Bound the
 * read well above that so a huge or crafted file is rejected before it is
 * fully read into memory, without being so tight that it's brittle.
 */
const MAX_ID_FILE_BYTES = 128;

/** Absolute path to the project identity file (`<projectRoot>/.pi/ward.id`). */
export function projectIdPath(projectRoot: string): string {
  return join(projectRoot, ".pi", "ward.id");
}

/**
 * Read and validate the project identity file.
 *
 * Only a missing file (`ENOENT`) means "no identity" and returns `null`.
 * Any other problem — an unreadable file, a symlink or other non-regular
 * file, an oversized file, extra content, or a malformed/non-canonical
 * UUID — is an active malformed identity and throws a descriptive error so
 * the caller fails closed at startup instead of silently treating a
 * tampered or broken id as "no persistent grants".
 */
export async function readProjectId(projectRoot: string): Promise<string | null> {
  const path = projectIdPath(projectRoot);

  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return null;
    throw new Error(`Cannot stat project id file "${path}": ${(err as Error).message}`);
  }

  // lstat (not stat) so a symlink reports as a symlink, not as whatever it
  // points to — isFile() is false for symlinks, directories, and special files.
  if (!st.isFile()) {
    throw new Error(`Project id file "${path}" is not a regular file (symlink or special file).`);
  }
  if (st.size > MAX_ID_FILE_BYTES) {
    throw new Error(`Project id file "${path}" is too large (${st.size} bytes).`);
  }

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read project id file "${path}": ${(err as Error).message}`);
  }

  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (trimmed.includes("\n") || !UUID_RE.test(trimmed)) {
    throw new Error(`Project id file "${path}" does not contain a single canonical UUID.`);
  }
  return trimmed;
}

/**
 * Generate a canonical (lowercase, hyphenated) random UUID, without writing
 * it anywhere. Intended for UI flows that need to preview/confirm an id
 * before it is persisted via `createProjectId`.
 */
export function generateProjectId(): string {
  return randomUUID();
}

/**
 * Create `<projectRoot>/.pi/ward.id` with a caller-supplied, valid UUID.
 *
 * Creation is exclusive (`O_CREAT|O_EXCL`, mode 0600). If the file already
 * exists:
 * - with the same id, this is idempotent and returns that id without
 *   rewriting the file;
 * - with a different or malformed id, this fails without overwriting.
 *
 * Throws if `id` is not a canonical UUID.
 */
export async function createProjectId(projectRoot: string, id: string): Promise<string> {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid project id: "${id}"`);
  }

  const path = projectIdPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });

  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${id}\n`, "utf-8");
    } finally {
      await handle.close();
    }
    return id;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      const existing = await readProjectId(projectRoot);
      if (existing === id) return id;
      throw new Error(`Project id file "${path}" already contains a different id.`);
    }
    throw err;
  }
}

const GrantSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Literal absolute or `~/`-prefixed path this grant applies to. A trailing `/` grants the directory and its descendants. Globs and relative paths are rejected.",
    }),
    operations: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
  },
  { additionalProperties: false },
);

export const GrantsFileSchema = Type.Object(
  {
    grants: Type.Array(GrantSchema),
  },
  { additionalProperties: false },
);

export interface Grant {
  path: string;
  operations?: Operation;
}

export interface GrantsFile {
  grants: Grant[];
}

/** A grant entry after resolution/canonicalization at load time. */
export interface ParsedGrant {
  /** Resolved (realpath) absolute target path. */
  resolvedPath: string;
  /** Always explicit — defaulted to "read" when omitted on the raw entry. */
  operations: Operation;
  /** Whether the grant covers the target and everything under it. */
  directory: boolean;
}

/** Characters that indicate glob/wildcard intent — rejected for grant paths. */
function containsGlob(inputPath: string): boolean {
  return /[*?]|\[|\]/.test(inputPath);
}

function validateGrantsFile(raw: unknown, filePath: string): GrantsFile {
  if (!Value.Check(GrantsFileSchema, raw)) {
    const errors = Value.Errors(GrantsFileSchema, raw);
    const first = errors[0];
    if (first === undefined) {
      throw new Error(`Grants file "${filePath}": schema validation failed`);
    }
    throw new Error(`Grants file "${filePath}": ${first.instancePath}: ${first.message}`);
  }
  return raw;
}

function parseGrantsJson(raw: string, filePath: string): GrantsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in grants file "${filePath}": ${(err as Error).message}`);
  }
  return validateGrantsFile(parsed, filePath);
}

/**
 * Reject grant paths that are not literal absolute or `~/`-prefixed paths, or
 * that contain glob/wildcard characters.
 */
function validateGrantPathSyntax(rawPath: string, filePath: string, idx: number): void {
  if (containsGlob(rawPath)) {
    throw new Error(
      `Grants file "${filePath}": grants[${idx}].path "${rawPath}" contains glob characters; only literal paths are allowed.`,
    );
  }
  if (!rawPath.startsWith("~/") && !isAbsolute(rawPath)) {
    throw new Error(
      `Grants file "${filePath}": grants[${idx}].path "${rawPath}" must be an absolute path or start with "~/".`,
    );
  }
}

/**
 * Resolve and canonicalize a single grant entry. A persistent grants file is
 * a trusted authority file, so invalid path syntax or an unresolvable/broken
 * target fails closed by throwing rather than being silently skipped.
 */
async function resolveGrantEntry(grant: Grant, homeDir: string, filePath: string, idx: number): Promise<ParsedGrant> {
  validateGrantPathSyntax(grant.path, filePath, idx);
  const directory = grant.path.endsWith("/");
  // Grant paths are always absolute or `~/`-prefixed, so `projectRoot` is
  // never consulted by resolvePath here.
  const resolved = await resolvePath(grant.path, homeDir, homeDir);
  if (resolved.denied) {
    throw new Error(
      `Grants file "${filePath}": grants[${idx}].path "${grant.path}" cannot be resolved: ${resolved.denied}`,
    );
  }
  return { resolvedPath: resolved.path, operations: grant.operations ?? "read", directory };
}

/** A grant entry prepared from a single command's literal path + operation input. */
export interface PreparedGrant {
  /** Grant entry in persisted form (`~/`-relative when under home, else absolute). */
  grant: Grant;
  /** Resolved data for duplicate/broader-grant comparisons against existing `ParsedGrant`s. */
  parsed: ParsedGrant;
}

/**
 * Prepare a single grant from a command's literal input path and operation,
 * ready to insert into a `GrantsFile` and to compare against existing
 * `ParsedGrant`s for duplicate/broader-grant checks.
 *
 * - Rejects glob/wildcard paths.
 * - Resolves a relative `inputPath` against `projectRoot` (and expands `~`).
 * - Rejects a target that cannot be resolved (broken symlink, unresolvable ancestor).
 * - Rejects a self-protected target (ward config/identity/grants file) for `operation`.
 * - Treats the target as a directory (recursive grant) when `inputPath` has a
 * trailing slash (even if the directory does not yet exist) or when it
 * resolves to an existing directory (even without a trailing slash).
 * - Persists the target as an equivalent `~/`-prefixed path when it is under
 * `homeDir`, otherwise as the canonical absolute path.
 */
export async function prepareGrantInput(
  inputPath: string,
  operation: Operation,
  projectRoot: string,
  homeDir?: string,
  protectedIdentities?: ProtectedIdentity[],
): Promise<PreparedGrant> {
  if (containsGlob(inputPath)) {
    throw new Error(`Grant path "${inputPath}" contains glob characters; only literal paths are allowed.`);
  }

  const home = homeDir ?? homedir();

  const resolved = await resolvePath(inputPath, projectRoot, home);
  if (resolved.denied) {
    throw new Error(`Grant path "${inputPath}" cannot be resolved: ${resolved.denied}`);
  }

  if (await isSelfProtected(resolved.nominalPath, resolved.path, operation, protectedIdentities ?? [])) {
    throw new Error(`Cannot grant ${operation}: "${inputPath}" is a ward config file (${operation}-protected)`);
  }

  const directory = inputPath.endsWith("/") || (await isDirectory(resolved.path));

  let persistedPath: string;
  if (resolved.path === home || isDescendantOf(home, resolved.path)) {
    const rel = relative(home, resolved.path);
    persistedPath = rel === "" ? "~/" : `~/${rel}`;
  } else {
    persistedPath = resolved.path;
  }
  if (directory && !persistedPath.endsWith("/")) {
    persistedPath = `${persistedPath}/`;
  }

  return {
    grant: { path: persistedPath, operations: operation },
    parsed: { resolvedPath: resolved.path, operations: operation, directory },
  };
}

/** Absolute path to the canonical grants directory (`~/.pi/agent/ward/`). */
function grantsDirPath(): string {
  return join(getAgentDir(), "ward");
}

/**
 * Compute the canonical (realpath-resolved) path to a project's grants file,
 * verifying it has not escaped the canonical grants directory (e.g. via a
 * symlinked ancestor). Throws on an invalid id or an escape.
 *
 * Exported so UI flows can safely preview the on-disk grants file path
 * without duplicating the escape-check logic.
 */
export async function canonicalGrantsPath(id: string): Promise<string> {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid project id: "${id}"`);
  }
  const dir = grantsDirPath();
  const nominalPath = join(dir, `${id}.grants.json`);

  const resolvedDir = (await resolveRealPath(dir)) ?? dir;
  const resolvedPath = (await resolveRealPath(nominalPath)) ?? nominalPath;

  if (!isDescendantOf(resolvedDir, resolvedPath)) {
    throw new Error(`Grants path for id "${id}" escapes the canonical grants directory`);
  }

  // Reject an existing grants-file node that is a symlink or other
  // non-regular file, even though it resolved to a target within the
  // canonical grants directory (an "internal" symlink would otherwise be
  // accepted here, while still not being the trusted regular file it
  // appears to be). A missing node is fine — it means no grants file yet.
  let st: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    st = await lstat(nominalPath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      throw new Error(`Cannot stat grants file for id "${id}": ${(err as Error).message}`);
    }
  }
  if (st !== undefined) {
    if (st.isSymbolicLink()) {
      throw new Error(`Grants file for id "${id}" is a symlink, not a regular file`);
    }
    if (!st.isFile()) {
      throw new Error(`Grants file for id "${id}" is not a regular file`);
    }
  }

  return resolvedPath;
}

/**
 * Read the raw text content of a grants file.
 * Returns null on ENOENT. Throws on EACCES or other read errors.
 */
async function readGrantsFileRaw(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return null;
    throw new Error(`Cannot read grants file "${filePath}": ${(err as Error).message}`);
  }
}

export interface ProjectGrantState {
  /** The project's identity (`ward.id`), or `null` when it does not exist. */
  id: string | null;
  /** Raw on-disk bytes of the grants file, or `null` if it does not exist. */
  raw: string | null;
  /** Validated grants file content (`{ grants: [] }` when `raw` is `null`). */
  grantsFile: GrantsFile;
  /** Resolved persistent grants (empty when there is no active identity/grants file). */
  grants: ParsedGrant[];
  /**
   * On-disk identities of the active project's `ward.id` (read+write
   * protected) and its grants file (write protected), when they exist. Used
   * to fold into the session's self-protection `protectedIdentities` so
   * hardlink/symlink aliases to either file are also protected.
   */
  identities: ProtectedIdentity[];
}

/**
 * Load a project's complete persistent grant state in one pass: its identity
 * (`ward.id`, or `null`), the raw + validated grants file snapshot (for use
 * as `previousRaw` in `persistGrantsFile`/`deleteGrantsFile`), the
 * parsed/resolved grants, and the on-disk identities of its identity/grants
 * files (for self-protection).
 *
 * - Missing `ward.id` means no persistent project grants — returns `{ id:
 *   null, raw: null, grantsFile: { grants: [] }, grants: [], identities: []
 *   }`.
 * - A malformed/unreadable `ward.id` (per `readProjectId`) fails closed by
 *   throwing rather than silently treating it as "no identity".
 * - An existing id with a missing grants file returns the id plus the
 *   ward.id identity, with an otherwise-empty snapshot/grants.
 * - A malformed/unreadable grants file, or a grant whose target cannot be
 *   resolved (broken symlink, invalid syntax), fails closed by throwing.
 */
export async function loadProjectGrantState(projectRoot: string, homeDir?: string): Promise<ProjectGrantState> {
  const home = homeDir ?? homedir();

  const id = await readProjectId(projectRoot);
  if (id === null) {
    return { id: null, raw: null, grantsFile: { grants: [] }, grants: [], identities: [] };
  }

  const identities: ProtectedIdentity[] = [{ ...(await identityFor(projectIdPath(projectRoot))), protectRead: true }];

  const path = await canonicalGrantsPath(id);
  const raw = await readGrantsFileRaw(path);
  if (raw === null) {
    return { id, raw: null, grantsFile: { grants: [] }, grants: [], identities };
  }

  identities.push(await identityFor(path));

  const grantsFile = parseGrantsJson(raw, path);
  const grants: ParsedGrant[] = [];
  for (let i = 0; i < grantsFile.grants.length; i++) {
    grants.push(await resolveGrantEntry(grantsFile.grants[i], home, path, i));
  }

  return { id, raw, grantsFile, grants, identities };
}

export type PersistGrantsResult = { ok: true } | { ok: false; reason: string };

export interface PersistGrantsParams {
  /** The project's identity (from `readProjectId`/`createProjectId`). */
  id: string;
  /** Complete desired grants file content to write. */
  grantsFile: GrantsFile;
  /** Raw bytes of the grants file as previously read (or `null` if absent). */
  previousRaw: string | null;
  homeDir?: string;
}

/**
 * Persist a complete, previously-approved grants file for a project id.
 *
 * Acquires a cooperative, fail-fast exclusive lock (a sibling `.lock` file
 * created with O_CREAT|O_EXCL). Under the lock:
 * - Re-reads the grants file and aborts if its raw bytes differ from
 *   `previousRaw` (the source changed since the caller prepared this write).
 * - Validates the complete proposed file against the schema and resolves
 *   every entry (catching invalid syntax or broken targets) before writing.
 * - Writes a same-directory temp file and atomically renames it into place,
 *   preserving the existing file's permission mode (or 0600 for a new file).
 *
 * Creates the grants directory with mode 0700 if it does not already exist,
 * and tightens it to 0700 even when it already existed with a more
 * permissive mode.
 * Cleans up the temp file and the lock file on any handled failure.
 */
export async function persistGrantsFile(params: PersistGrantsParams): Promise<PersistGrantsResult> {
  const { id, grantsFile, previousRaw } = params;
  const home = params.homeDir ?? homedir();

  const dir = grantsDirPath();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies on creation — enforce it here too, so a
    // pre-existing, more permissive grants directory is tightened as well.
    await chmod(dir, 0o700);
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot persist grants: failed to prepare grants directory: ${(err as Error).message}`,
    };
  }

  let path: string;
  try {
    path = await canonicalGrantsPath(id);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const lockPath = `${path}.lock`;
  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      return {
        ok: false,
        reason: "Cannot persist grants: another ward grants write is already in progress (lock file exists).",
      };
    }
    return { ok: false, reason: `Cannot persist grants: failed to acquire lock: ${(err as Error).message}` };
  }

  let tmpPath: string | undefined;
  let tmpHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const raw = await readGrantsFileRaw(path);
    if (raw !== previousRaw) {
      return {
        ok: false,
        reason: "Aborted: the grants file changed since this write was prepared. Please retry.",
      };
    }

    try {
      const validated = validateGrantsFile(grantsFile, path);
      for (let i = 0; i < validated.grants.length; i++) {
        await resolveGrantEntry(validated.grants[i], home, path, i);
      }
    } catch (err) {
      return { ok: false, reason: `Resulting grants file would be invalid: ${(err as Error).message}` };
    }

    let mode = 0o600;
    if (raw !== null) {
      const st = await stat(path);
      mode = st.mode & 0o777 & ~0o022;
    }

    tmpPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    tmpHandle = await open(tmpPath, "wx", mode);
    // `open`'s mode argument is subject to the process umask, which can
    // silently strip bits from an existing file's captured mode (e.g. group
    // read on 0640 under a restrictive umask). Force the exact mode.
    await tmpHandle.chmod(mode);
    await tmpHandle.writeFile(`${JSON.stringify(grantsFile, null, 2)}\n`, "utf-8");
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

export interface DeleteGrantsParams {
  /** The project's identity (from `readProjectId`/`createProjectId`). */
  id: string;
  /** Raw bytes of the grants file as previously read; the file must still exist. */
  previousRaw: string;
}

/**
 * Delete a project's grants file for good (e.g. once its last grant has been
 * revoked), without touching `ward.id`.
 *
 * Acquires the same cooperative, fail-fast exclusive lock as
 * `persistGrantsFile` (a sibling `.lock` file created with O_CREAT|O_EXCL).
 * Under the lock:
 * - Fails if the grants file no longer exists (nothing to delete).
 * - Fails if its raw bytes differ from `previousRaw` (the source changed
 *   since the caller prepared this delete).
 * - Otherwise removes the file.
 *
 * Cleans up the lock file in all cases.
 */
export async function deleteGrantsFile(params: DeleteGrantsParams): Promise<PersistGrantsResult> {
  const { id, previousRaw } = params;

  let path: string;
  try {
    path = await canonicalGrantsPath(id);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const lockPath = `${path}.lock`;
  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      return {
        ok: false,
        reason: "Cannot delete grants: another ward grants write is already in progress (lock file exists).",
      };
    }
    if (code === "ENOENT") {
      // The grants directory itself doesn't exist, so the grants file can't either.
      return { ok: false, reason: `Cannot delete grants: expected grants file "${path}" does not exist.` };
    }
    return { ok: false, reason: `Cannot delete grants: failed to acquire lock: ${(err as Error).message}` };
  }

  try {
    const raw = await readGrantsFileRaw(path);
    if (raw === null) {
      return { ok: false, reason: `Cannot delete grants: expected grants file "${path}" does not exist.` };
    }
    if (raw !== previousRaw) {
      return {
        ok: false,
        reason: "Aborted: the grants file changed since this delete was prepared. Please retry.",
      };
    }

    await rm(path);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    await lockHandle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
