import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Returns true if the given absolute path is a protected ward config file.
 *
 * Two categories are always write-protected:
 *
 * 1. The global config — `~/.pi/agent/ward.json` (exact path match).
 * 2. Any path of the form `<anything>/.pi/ward.json` — covers the project config
 *    and any other `.pi/ward.json` regardless of location. Protects nonexistent
 *    paths too (creation is denied), so the agent cannot create a ward config
 *    it could later exploit.
 *
 * The check is applied to the resolved (realpath'd) absolute path so symlinks
 * cannot bypass it for real files. For new-file writes the path is resolved
 * through the nearest existing ancestor, preserving the `.pi/ward.json` suffix.
 */
export function isSelfProtected(absolutePath: string): boolean {
  // Protect the global config explicitly (structure is .pi/agent/ward.json,
  // not .pi/ward.json, so the structural predicate below does not cover it).
  if (absolutePath === join(getAgentDir(), "ward.json")) return true;

  // Protect any .../.pi/ward.json path structurally.
  return basename(absolutePath) === "ward.json" && basename(dirname(absolutePath)) === ".pi";
}
