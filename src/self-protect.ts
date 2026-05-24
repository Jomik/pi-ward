import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ancestorDirs } from "./walk.js";

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

  // Global config is always protected.
  const paths = [join(getAgentDir(), "ward.json")];

  // Walk ancestor directories from home to projectRoot (mirrors loadConfig walk).
  // ancestorDirs returns [] when projectRoot is outside home, so this is a no-op in that case.
  const dirs = ancestorDirs(home, projectRoot);
  for (const dir of dirs) {
    paths.push(join(dir, ".pi", "ward.json"));
  }

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
