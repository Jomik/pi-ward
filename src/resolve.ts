import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface ResolveResult {
  /** Resolved absolute real path. Only meaningful when denied is not set. */
  path: string;
  /** If set, the path should be denied with this reason (before rule evaluation). */
  denied?: string;
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
  const normalized = isAbsolute(inputPath) ? inputPath : resolve(projectRoot, inputPath);

  try {
    const real = await realpath(normalized);
    return { path: real };
  } catch (err) {
    const code = (err as { code?: string }).code;

    if (code === "ENOENT") {
      // Use lstat to distinguish:
      //   - lstat succeeds: path exists as a symlink but target is missing (dangling symlink)
      //   - lstat fails ENOENT: path genuinely doesn't exist (new-file case)
      try {
        await lstat(normalized);
        // lstat succeeded but realpath failed — dangling/broken symlink.
        return { path: normalized, denied: `Broken symlink at "${normalized}"` };
      } catch (lstatErr) {
        const lstatCode = (lstatErr as { code?: string }).code;
        if (lstatCode === "ENOENT") {
          // File genuinely doesn't exist — attempt to resolve the parent for new-file writes.
          const parent = dirname(normalized);
          const base = basename(normalized);
          try {
            const realParent = await realpath(parent);
            return { path: resolve(realParent, base) };
          } catch (parentErr) {
            return {
              path: normalized,
              denied: `Cannot resolve path "${normalized}": ${(parentErr as Error).message}`,
            };
          }
        }
        // lstat failed for a non-ENOENT reason (e.g. EACCES, ELOOP in path components).
        return { path: normalized, denied: `Cannot resolve path "${normalized}": ${(lstatErr as Error).message}` };
      }
    }

    // Fail-closed for all other errors (EACCES, ELOOP, ENOTDIR, etc.).
    return { path: normalized, denied: `Cannot resolve path "${normalized}": ${(err as Error).message}` };
  }
}
