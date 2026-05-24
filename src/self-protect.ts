import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns all ward config file paths that are always write-protected.
 *
 * Protected paths (mirrors the loadConfig walk order):
 * - `~/.pi/agent/ward.json` (global config, always protected)
 * - `<dir>/.pi/ward.json` for each ancestor directory from homedir down to projectRoot
 * - `<projectRoot>/.pi/ward.json`
 *
 * If projectRoot is outside homedir, only the global config path is returned.
 */
export function getProtectedPaths(projectRoot: string, homeDir?: string): string[] {
  const home = homeDir ?? homedir();
  const paths: string[] = [];

  // Global config is always protected.
  paths.push(join(home, ".pi", "agent", "ward.json"));

  // If projectRoot is outside home, only the global config applies.
  const homePrefix = home.endsWith("/") ? home : `${home}/`;
  const projectInsideHome = projectRoot === home || projectRoot.startsWith(homePrefix);
  if (!projectInsideHome) {
    return paths;
  }

  // Walk ancestor directories from home to projectRoot (mirrors loadConfig walk).
  const relPath = projectRoot.slice(home.length).replace(/^\//, "");
  const segments = relPath === "" ? [] : relPath.split("/").filter((s) => s !== "");

  let current = home;
  for (let i = 0; i < segments.length; i++) {
    paths.push(join(current, ".pi", "ward.json"));
    current = join(current, segments[i]);
  }
  // current === projectRoot at this point
  paths.push(join(projectRoot, ".pi", "ward.json"));

  return paths;
}

/**
 * Returns true if the given absolute path is a protected ward config file.
 *
 * Protected config files are always write-denied regardless of rules —
 * the agent cannot modify its own access controls.
 */
export function isSelfProtected(absolutePath: string, protectedPaths: string[]): boolean {
  return protectedPaths.includes(absolutePath);
}
