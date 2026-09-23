import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before imports that use getAgentDir so vitest can hoist it.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

import { link, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { guard } from "../src/guard.js";

const mockGetAgentDir = vi.mocked(getAgentDir);

let tempDir: string;

beforeEach(async () => {
  const base = join(tmpdir(), `pi-ward-self-protect-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(base, { recursive: true });
  tempDir = await realpath(base);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * End-to-end proof that nominal-path preservation (resolve.ts) composes with
 * guard self-protection (self-protect.ts + config.ts loadConfig) across a
 * real symlinked `.pi` ancestor for the global config — not a synthetic
 * path. Also verifies a project-local `.pi/ward.json` is no longer loaded or
 * structurally protected.
 */
describe("self-protection end-to-end — symlinked global .pi ancestor; project config not protected", () => {
  it("denies writes to the global config by nominal structure and to an identity-aliased path, through a real symlinked ancestor", async () => {
    // --- Global config behind a symlinked `.pi` ancestor ---
    const realHome = join(tempDir, "real-home");
    await mkdir(join(realHome, ".pi", "agent"), { recursive: true });
    const realGlobalConfig = join(realHome, ".pi", "agent", "ward.json");
    await writeFile(realGlobalConfig, '{"rules":[]}');

    const home = join(tempDir, "home");
    await mkdir(home, { recursive: true });
    // home/.pi -> real-home/.pi (symlinked global ancestor)
    await symlink(join(realHome, ".pi"), join(home, ".pi"));

    const nominalGlobalConfig = join(home, ".pi", "agent", "ward.json");
    mockGetAgentDir.mockReturnValue(join(home, ".pi", "agent"));

    // --- A project-local `.pi/ward.json` exists on disk but is not loaded ---
    const projectRoot = join(tempDir, "project");
    await mkdir(join(projectRoot, ".pi"), { recursive: true });
    const projectConfig = join(projectRoot, ".pi", "ward.json");
    await writeFile(projectConfig, '{"rules":[]}');

    // Load the (global-only) config through its symlinked ancestor.
    const { rules, protectedIdentities } = await loadConfig(home);
    expect(protectedIdentities).toHaveLength(1);

    // 1. Writing to the nominal (pre-resolution) global config path is denied
    //    structurally, even though the symlinked `.pi` ancestor rewrites the
    //    real path to something under real-home/.pi.
    const globalResult = await guard(
      "write",
      [nominalGlobalConfig],
      "write",
      rules,
      projectRoot,
      undefined,
      protectedIdentities,
    );
    expect(globalResult.allowed).toBe(false);
    if (!globalResult.allowed) expect(globalResult.reason).toMatch(/ward config/i);

    // 2. A hardlink alias to the real global config file, at a path that
    //    does not structurally look like the global config at all, is still
    //    denied — purely via active on-disk identity, threaded end-to-end
    //    from `loadConfig` through `guard`.
    const alias = join(tempDir, "totally-unrelated-name.txt");
    await link(realGlobalConfig, alias);
    const aliasResult = await guard("write", [alias], "write", rules, projectRoot, undefined, protectedIdentities);
    expect(aliasResult.allowed).toBe(false);
    if (!aliasResult.allowed) expect(aliasResult.reason).toMatch(/ward config/i);

    // 3. The project-local .pi/ward.json is not loaded and carries no active
    //    identity, so it is no longer structurally self-protected — writing
    //    it is governed by ordinary baseline/rule evaluation (allowed here,
    //    since it's inside the project root and no rule denies it).
    const projectResult = await guard(
      "write",
      [projectConfig],
      "write",
      rules,
      projectRoot,
      undefined,
      protectedIdentities,
    );
    expect(projectResult.allowed).toBe(true);

    // 4. An unrelated, non-aliased file (inside the project root, so baseline
    //    rules alone would allow it) is unaffected by the protection.
    const unrelated = join(projectRoot, "unrelated.txt");
    await writeFile(unrelated, "just data");
    const unrelatedResult = await guard(
      "read",
      [unrelated],
      "read",
      rules,
      projectRoot,
      undefined,
      protectedIdentities,
    );
    expect(unrelatedResult.allowed).toBe(true);
  });
});
