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
 * guard self-protection (self-protect.ts + config.ts loadConfig) across real
 * symlinked `.pi` ancestors for both the project config and the global
 * config — not synthetic paths.
 */
describe("self-protection end-to-end — symlinked project and global .pi ancestors", () => {
  it("denies writes to both configs by nominal structure, and to an identity-aliased path, through real symlinked ancestors", async () => {
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

    // --- Project config behind a symlinked `.pi` ancestor ---
    const realProjectBase = join(tempDir, "real-project");
    await mkdir(join(realProjectBase, ".pi"), { recursive: true });
    const realProjectConfig = join(realProjectBase, ".pi", "ward.json");
    await writeFile(realProjectConfig, '{"rules":[]}');

    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot, { recursive: true });
    // project/.pi -> real-project/.pi (symlinked project ancestor)
    await symlink(join(realProjectBase, ".pi"), join(projectRoot, ".pi"));

    const nominalProjectConfig = join(projectRoot, ".pi", "ward.json");

    // Load both configs through their symlinked ancestors.
    const { rules, protectedIdentities } = await loadConfig(projectRoot, home);
    expect(protectedIdentities).toHaveLength(2);

    // 1. Writing to the nominal (pre-resolution) project config path is denied
    //    structurally, even though the symlinked `.pi` ancestor rewrites the
    //    real path to something under real-project/.pi.
    const projectResult = await guard(
      "write",
      [nominalProjectConfig],
      "write",
      rules,
      projectRoot,
      undefined,
      protectedIdentities,
    );
    expect(projectResult.allowed).toBe(false);
    if (!projectResult.allowed) expect(projectResult.reason).toMatch(/ward config/i);

    // 2. Same for the nominal global config path.
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

    // 3. A hardlink alias to the real project config file, at a path that
    //    does not structurally look like `.pi/ward.json` at all, is still
    //    denied — purely via active on-disk identity, threaded end-to-end
    //    from `loadConfig` through `guard`.
    const alias = join(tempDir, "totally-unrelated-name.txt");
    await link(realProjectConfig, alias);
    const aliasResult = await guard("write", [alias], "write", rules, projectRoot, undefined, protectedIdentities);
    expect(aliasResult.allowed).toBe(false);
    if (!aliasResult.allowed) expect(aliasResult.reason).toMatch(/ward config/i);

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
