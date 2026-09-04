import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Identity (device + inode) of an actively loaded ward config file, captured
 * at load time (after symlink resolution). Used to detect a hardlink or
 * symlink alias — a different path that refers to the exact same on-disk
 * file as a config that is currently in effect.
 */
export interface ProtectedIdentity {
  dev: number;
  ino: number;
}

/**
 * Returns true if the given path is a protected ward config file.
 *
 * Two kinds of checks are applied:
 *
 * 1. Structural/global checks, evaluated against *both* `nominalPath` — the
 *    normalized path *before* symlink resolution — and `resolvedPath` — the
 *    fully symlink-resolved real path:
 *    - The global config — `~/.pi/agent/ward.json` (exact path match).
 *    - Any path of the form `<anything>/.pi/ward.json`.
 *    Checking the nominal form means a symlinked `.pi` or `.pi/agent`
 *    ancestor (which would rewrite the resolved path to something that no
 *    longer structurally looks like `.pi/ward.json`) cannot bypass the
 *    check — the write is still nominally targeting a protected config
 *    path. This also protects nonexistent paths (creation is denied).
 *    Checking the resolved form as well means a non-structural alias (e.g.
 *    a symlink whose target is a real `.pi/ward.json` belonging to a
 *    project that has not been loaded, so no active identity is recorded
 *    for it) is still caught structurally.
 *
 * 2. Active identity checks, evaluated against `resolvedPath`.
 *    `activeIdentities` carries the (dev, ino) of every config file
 *    currently loaded and in effect. If the resolved target's on-disk
 *    identity matches one of these, the path is a hardlink or symlink
 *    alias to an active config and is also protected — even though neither
 *    its nominal nor resolved path structurally looks like a ward config.
 *
 * Identity inspection fails closed: if `activeIdentities` is non-empty (there
 * is something to protect) and the target's identity cannot be determined
 * for a reason other than the target simply not existing, the path is
 * treated as protected.
 */
export async function isSelfProtected(
  nominalPath: string,
  resolvedPath: string,
  activeIdentities: ProtectedIdentity[] = [],
): Promise<boolean> {
  const globalConfigPath = join(getAgentDir(), "ward.json");
  // Protect the global config explicitly (structure is .pi/agent/ward.json,
  // not .pi/ward.json, so the structural predicate below does not cover it).
  if (nominalPath === globalConfigPath || resolvedPath === globalConfigPath) return true;

  // Protect any .../.pi/ward.json path structurally, checked against both
  // the nominal and resolved forms.
  const isStructural = (p: string) => basename(p) === "ward.json" && basename(dirname(p)) === ".pi";
  if (isStructural(nominalPath) || isStructural(resolvedPath)) return true;

  if (activeIdentities.length === 0) return false;

  try {
    const st = await stat(resolvedPath);
    return activeIdentities.some((id) => id.dev === st.dev && id.ino === st.ino);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return false; // target doesn't exist — can't alias an existing file
    return true; // fail closed — identity of an apparent protected target cannot be verified
  }
}
