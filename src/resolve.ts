import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface ResolveResult {
  /** Resolved absolute real path. Only meaningful when denied is not set. */
  path: string;
  /** If set, the path should be denied with this reason (before rule evaluation). */
  denied?: string;
}

/**
 * Handle the ENOENT case from realpath: distinguish a dangling symlink from a
 * genuinely absent file (new-file write), then resolve the parent directory.
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

  // File genuinely doesn't exist — walk up until we find an existing ancestor,
  // resolve it via realpath, then re-append the missing tail segments.
  // This allows writes to paths with non-existent intermediate directories
  // (e.g. "designs/foo.md" where "designs/" hasn't been created yet).
  let current = normalized;
  const segments: string[] = [];
  while (true) {
    const parent = dirname(current);
    segments.unshift(basename(current));
    if (parent === current) {
      // Reached filesystem root without finding an existing ancestor.
      return {
        path: normalized,
        denied: `Cannot resolve path "${normalized}": no existing ancestor directory`,
      };
    }
    current = parent;
    try {
      const realAncestor = await realpath(current);
      return { path: resolve(realAncestor, ...segments) };
    } catch (ancestorErr) {
      const ancestorCode = (ancestorErr as { code?: string }).code;
      if (ancestorCode === "ENOENT") {
        // This ancestor doesn't exist either — keep walking up.
        continue;
      }
      // Non-ENOENT error (EACCES, ELOOP, etc.) — fail closed.
      return {
        path: normalized,
        denied: `Cannot resolve path "${normalized}": ${(ancestorErr as Error).message}`,
      };
    }
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
