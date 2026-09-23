import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Operation } from "./rules.js";

/**
 * Identity (device + inode) of an actively loaded ward config/identity/grants
 * file, captured at load time (after symlink resolution). Used to detect a
 * hardlink or symlink alias — a different path that refers to the exact same
 * on-disk file as a config that is currently in effect.
 */
export interface ProtectedIdentity {
  dev: number;
  ino: number;
  /**
   * When true, this identity is protected against both reads and writes
   * (the project identity file, `ward.id`). Defaults to write-only
   * protection, used for config files and grants files.
   */
  protectRead?: boolean;
}

/**
 * Returns true if the given path is a protected ward config, identity, or
 * grants file, for the given `operation`.
 *
 * Two structural predicates (`.../.pi/ward.id` and
 * `<agent grants dir>/*.grants.json`) are checked against *both*
 * `nominalPath` — the normalized path *before* symlink resolution — and
 * `resolvedPath` — the fully symlink-resolved real path. Checking the
 * nominal form means a symlinked ancestor (which would rewrite the resolved
 * path to something that no longer structurally matches) cannot bypass the
 * check — the access is still nominally targeting a protected path. This
 * also protects nonexistent paths (creation/pre-creation is denied).
 * Checking the resolved form as well means a non-structural alias (e.g. a
 * symlink whose target is a real protected path) is still caught
 * structurally.
 *
 * 1. `.../.pi/ward.id` — the project identity file. Protected from *both*
 *    reads and writes, regardless of `operation`, since it is consumed only
 *    by ward internally.
 * 2. The global config (`~/.pi/agent/ward.json`, exact match only) —
 *    protected from writes only. A project-local `<project>/.pi/ward.json`
 *    is not declarative policy and is not structurally protected; it is only
 *    caught below via active identity if it happens to be loaded and
 *    aliased.
 * 3. Any `<agent grants dir>/*.grants.json` path — protected from writes
 *    only. Reads are governed normally by other layers.
 *
 * Active identity checks are evaluated against `resolvedPath`.
 * `activeIdentities` carries the (dev, ino) of every config/identity/grants
 * file currently loaded and in effect. If the resolved target's on-disk
 * identity matches one of these, the path is a hardlink or symlink alias to
 * an active file and is also protected — even though neither its nominal nor
 * resolved path structurally looks like one. An identity's `protectRead`
 * flag determines whether it protects reads too (true only for `ward.id`);
 * otherwise it protects writes only.
 *
 * Identity inspection fails closed: if `activeIdentities` is non-empty (there
 * is something to protect) and the target's identity cannot be determined
 * for a reason other than the target simply not existing, the path is
 * treated as protected.
 */
export async function isSelfProtected(
  nominalPath: string,
  resolvedPath: string,
  operation: Operation,
  activeIdentities: ProtectedIdentity[] = [],
): Promise<boolean> {
  const globalConfigPath = join(getAgentDir(), "ward.json");
  const grantsDir = join(getAgentDir(), "ward");

  const isWardIdStructural = (p: string) => basename(p) === "ward.id" && basename(dirname(p)) === ".pi";
  const isGrantsStructural = (p: string) => dirname(p) === grantsDir && basename(p).endsWith(".grants.json");

  // `.pi/ward.id` is protected from both reads and writes, including before creation.
  if (isWardIdStructural(nominalPath) || isWardIdStructural(resolvedPath)) return true;

  if (operation === "write") {
    // Protect the global config explicitly (exact match only).
    if (nominalPath === globalConfigPath || resolvedPath === globalConfigPath) return true;

    // Protect any grants file under the canonical grants directory structurally.
    if (isGrantsStructural(nominalPath) || isGrantsStructural(resolvedPath)) return true;
  }

  if (activeIdentities.length === 0) return false;

  try {
    const st = await stat(resolvedPath);
    return activeIdentities.some(
      (id) => id.dev === st.dev && id.ino === st.ino && (operation === "write" || id.protectRead === true),
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return false; // target doesn't exist — can't alias an existing file
    return true; // fail closed — identity of an apparent protected target cannot be verified
  }
}
