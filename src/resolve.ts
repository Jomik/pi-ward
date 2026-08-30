import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface ResolveResult {
  /** Resolved absolute real path. Only meaningful when denied is not set. */
  path: string;
  /** If set, the path should be denied with this reason (before rule evaluation). */
  denied?: string;
}

/**
 * Expand bare '~', leading '~/' (all platforms), and leading '~\\' (Windows only)
 * to the given home directory, using path.join semantics.
 * '~user' forms are left unchanged, matching pi's normalizePath semantics.
 */
function expandTilde(inputPath: string, homeDir: string): string {
  if (inputPath === "~") return homeDir;
  if (inputPath.startsWith("~/")) return join(homeDir, inputPath.slice(2));
  if (process.platform === "win32" && inputPath.startsWith("~\\")) return join(homeDir, inputPath.slice(2));
  return inputPath;
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
 * - Expands bare '~' and leading '~/' to the home directory before resolution.
 *   '~user' forms are left unchanged (not expanded), matching pi's normalizePath semantics.
 * - Normalizes the path (resolves relative to projectRoot if not absolute).
 * - Resolves symlinks via fs.realpath.
 * - If the target doesn't exist (ENOENT):
 *   - Checks lstat to distinguish broken symlinks from genuinely absent files.
 *   - Broken/dangling symlink → denied.
 *   - File doesn't exist (new file case) → tries parent directory.
 *     - Parent resolves → returns parent + basename.
 *     - Parent fails → denied.
 * - Any other error → denied (fail-closed).
 *
 * @param homeDir - Override the home directory used for tilde expansion.
 *                  Defaults to os.homedir(). Accepts an override for deterministic tests.
 */
export async function resolvePath(inputPath: string, projectRoot: string, homeDir?: string): Promise<ResolveResult> {
  const expanded = expandTilde(inputPath, homeDir ?? homedir());
  const normalized = isAbsolute(expanded) ? resolve(expanded) : resolve(projectRoot, expanded);

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
