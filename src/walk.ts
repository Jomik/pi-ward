import { isAbsolute, join, relative } from "node:path";

/**
 * Returns true if `target` is at or below `base` in the directory tree.
 */
export function isDescendantOf(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !isAbsolute(rel) && !rel.startsWith("..");
}

/**
 * Compute ancestor directories from `home` toward `target`.
 * Returns an array of directory paths in walk order (home first, target last).
 * If target is not within home, returns an empty array.
 */
export function ancestorDirs(home: string, target: string): string[] {
  if (!isDescendantOf(home, target)) {
    return [];
  }

  const rel = relative(home, target);
  // rel is "" when home === target, otherwise segments separated by OS sep
  const segments = rel === "" ? [] : rel.split(/[/\\]/).filter((s) => s !== "");

  const dirs: string[] = [home];
  let current = home;
  for (const seg of segments) {
    current = join(current, seg);
    dirs.push(current);
  }
  return dirs;
}
