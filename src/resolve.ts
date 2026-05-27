import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface ResolveResult {
  /** Resolved absolute real path. Only meaningful when denied is not set. */
  path: string;
  /** If set, the path should be denied with this reason (before rule evaluation). */
  denied?: string;
}

/**
 * Resolve an absolute path through symlinks. If the full path doesn't exist,
 * walks up to find the nearest existing ancestor, resolves it via realpath,
 * and re-appends the remaining segments.
 *
 * Returns null if no existing ancestor can be found (walked to filesystem root).
 * Throws on non-ENOENT errors (EACCES, ELOOP, etc.) so callers can surface
 * the real failure cause.
 */
export async function resolveRealPath(absolutePath: string): Promise<string | null> {
  try {
    return await realpath(absolutePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") throw err;
  }

  // Walk up to find the nearest existing ancestor.
  let current = absolutePath;
  const segments: string[] = [];
  while (true) {
    const parent = dirname(current);
    segments.unshift(basename(current));
    if (parent === current) return null; // reached root, nothing resolvable
    current = parent;
    try {
      const realAncestor = await realpath(current);
      return resolve(realAncestor, ...segments);
    } catch (ancestorErr) {
      const ancestorCode = (ancestorErr as { code?: string }).code;
      if (ancestorCode === "ENOENT") continue;
      throw ancestorErr;
    }
  }
}

/**
 * Handle the ENOENT case from realpath: distinguish a dangling symlink from a
 * genuinely absent file (new-file write), then resolve via ancestor walk-up.
 */
async function resolveNewFile(normalized: string): Promise<ResolveResult> {
  try {
    await lstat(normalized);
    // lstat succeeded but realpath failed — dangling/broken symlink.
    return { path: normalized, denied: `Broken symlink at "${normalized}"` };
  } catch (lstatErr) {
    const lstatCode = (lstatErr as { code?: string }).code;
    if (lstatCode !== "ENOENT") {
      // lstat failed for a non-ENOENT reason (e.g. EACCES, ELOOP in path components).
      return { path: normalized, denied: `Cannot resolve path "${normalized}": ${(lstatErr as Error).message}` };
    }
  }

  // File genuinely doesn't exist — resolve through the nearest existing ancestor.
  try {
    const resolved = await resolveRealPath(normalized);
    if (resolved === null) {
      return {
        path: normalized,
        denied: `Cannot resolve path "${normalized}": no existing ancestor directory`,
      };
    }
    return { path: resolved };
  } catch (err) {
    return {
      path: normalized,
      denied: `Cannot resolve path "${normalized}": ${(err as Error).message}`,
    };
  }
}

/**
 * Resolve an input path to its real absolute path.
 *
 * - Normalizes the path (resolves relative to projectRoot if not absolute).
 * - Resolves symlinks via fs.realpath.
 * - If the target doesn't exist (ENOENT):
 *   - Checks lstat to distinguish broken symlinks from genuinely absent files.
 *   - Broken/dangling symlink → denied.
 *   - File doesn't exist (new file case) → tries parent directory.
 *     - Parent resolves → returns parent + basename.
 *     - Parent fails → denied.
 * - Any other error → denied (fail-closed).
 */
export async function resolvePath(inputPath: string, projectRoot: string): Promise<ResolveResult> {
  const normalized = isAbsolute(inputPath) ? resolve(inputPath) : resolve(projectRoot, inputPath);

  try {
    const real = await realpath(normalized);
    return { path: real };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return resolveNewFile(normalized);
    }
    return { path: normalized, denied: `Cannot resolve path "${normalized}": ${(err as Error).message}` };
  }
}
