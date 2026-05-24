import { join } from "node:path";

/**
 * Compute ancestor directories from `home` toward `target`.
 * Returns an array of directory paths in walk order (home first, target last).
 * If target is not within home, returns an empty array.
 */
export function ancestorDirs(home: string, target: string): string[] {
  const homePrefix = home.endsWith("/") ? home : `${home}/`;
  if (target !== home && !target.startsWith(homePrefix)) {
    return [];
  }

  const relPath = target.slice(home.length).replace(/^\//, "");
  const segments = relPath === "" ? [] : relPath.split("/").filter((s) => s !== "");

  const dirs: string[] = [home];
  let current = home;
  for (const seg of segments) {
    current = join(current, seg);
    dirs.push(current);
  }
  return dirs;
}
