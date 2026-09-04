import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before imports that use getAgentDir so vitest can hoist it.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSelfProtected } from "../src/self-protect.js";

const mockGetAgentDir = vi.mocked(getAgentDir);

const testHome = "/mock/home";
const testProject = join(testHome, "projects", "myproject");

beforeEach(() => {
  mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Convenience: call isSelfProtected with the same path as both nominal and resolved. */
async function protectedSamePath(path: string): Promise<boolean> {
  return isSelfProtected(path, path);
}

// ---------------------------------------------------------------------------
// isSelfProtected — structural predicate (.pi/ward.json)
// ---------------------------------------------------------------------------

describe("isSelfProtected — .pi/ward.json predicate", () => {
  it("returns true for the project config path", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", "ward.json"))).toBe(true);
  });

  it("returns true for a .pi/ward.json path anywhere in the tree", async () => {
    expect(await protectedSamePath("/some/other/.pi/ward.json")).toBe(true);
  });

  it("returns true for a .pi/ward.json path at the filesystem root level", async () => {
    expect(await protectedSamePath("/.pi/ward.json")).toBe(true);
  });

  it("returns true for .pi/ward.json inside home directory", async () => {
    expect(await protectedSamePath(join(testHome, ".pi", "ward.json"))).toBe(true);
  });

  it("returns true for .pi/ward.json in any ancestor directory", async () => {
    expect(await protectedSamePath(join(testHome, "projects", ".pi", "ward.json"))).toBe(true);
  });

  it("returns false for a non-ward.json filename in .pi/", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", "other.json"))).toBe(false);
  });

  it("returns false for ward.json not in a .pi/ directory", async () => {
    expect(await protectedSamePath(join(testProject, "ward.json"))).toBe(false);
  });

  it("returns false for a regular source file", async () => {
    expect(await protectedSamePath(join(testProject, "src", "index.ts"))).toBe(false);
  });

  it("returns false for a .pi/ directory itself (no ward.json)", async () => {
    expect(await protectedSamePath(join(testProject, ".pi"))).toBe(false);
  });

  it("returns false for ward.json nested deeper under .pi/", async () => {
    // .pi/agent/ward.json — parent is 'agent', not '.pi', so predicate is false
    // (global config is handled by the separate explicit check)
    expect(await protectedSamePath(join(testProject, ".pi", "agent", "ward.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — global config explicit check
// ---------------------------------------------------------------------------

describe("isSelfProtected — global config path", () => {
  it("returns true for the global config path (~/.pi/agent/ward.json)", async () => {
    expect(await protectedSamePath(join(testHome, ".pi", "agent", "ward.json"))).toBe(true);
  });

  it("returns false for a different ward.json under .pi/agent/", async () => {
    // If getAgentDir points elsewhere, a different path is not the global config
    mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
    expect(await protectedSamePath(join("/other", ".pi", "agent", "ward.json"))).toBe(false);
  });

  it("uses whatever path getAgentDir returns", async () => {
    mockGetAgentDir.mockReturnValue("/custom/agent/dir");
    expect(await protectedSamePath("/custom/agent/dir/ward.json")).toBe(true);
    expect(await protectedSamePath(join(testHome, ".pi", "agent", "ward.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — nonexistent path creation is blocked
// ---------------------------------------------------------------------------

describe("isSelfProtected — creation of nonexistent .pi/ward.json", () => {
  it("returns true for a nonexistent .pi/ward.json path (structural check applies)", async () => {
    // Even if the file doesn't exist, the resolved path still ends with .pi/ward.json
    // (resolvePath walks up to the nearest existing ancestor and re-appends the suffix)
    expect(await protectedSamePath("/nonexistent/dir/.pi/ward.json")).toBe(true);
  });

  it("returns false for a nonexistent path that does not match the pattern", async () => {
    expect(await protectedSamePath("/nonexistent/dir/ward.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — similar-looking paths that should NOT be protected
// ---------------------------------------------------------------------------

describe("isSelfProtected — similar paths that are not protected", () => {
  it("returns false for ward.json in a directory named pi (without dot)", async () => {
    expect(await protectedSamePath(join(testProject, "pi", "ward.json"))).toBe(false);
  });

  it("returns false for ward.json in a directory named .pi-backup", async () => {
    expect(await protectedSamePath(join(testProject, ".pi-backup", "ward.json"))).toBe(false);
  });

  it("returns false for ward.json in a directory named pi. (trailing dot)", async () => {
    expect(await protectedSamePath(join(testProject, "pi.", "ward.json"))).toBe(false);
  });

  it("returns false for .ward.json in a .pi/ directory", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", ".ward.json"))).toBe(false);
  });

  it("returns false for ward.json.bak in a .pi/ directory", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", "ward.json.bak"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — nominal vs. resolved path divergence (symlinked ancestor)
// ---------------------------------------------------------------------------

describe("isSelfProtected — nominal path used for structural checks", () => {
  it("returns true when the nominal path is .pi/ward.json even if the resolved path is elsewhere", async () => {
    // Simulates a symlinked .pi ancestor: nominal (pre-resolution) path still
    // literally ends in .pi/ward.json, but the resolved (real) path is rewritten.
    const nominal = join(testProject, ".pi", "ward.json");
    const resolved = join("/elsewhere", "real-config.json");
    expect(await isSelfProtected(nominal, resolved)).toBe(true);
  });

  it("returns true when only the resolved path looks like .pi/ward.json but nominal does not, even with no active identities", async () => {
    // A non-structural alias (e.g. a symlink) whose resolved target is a real
    // .pi/ward.json belonging to a project that has not been loaded (so no
    // active identity is recorded for it) is still caught structurally.
    const nominal = join("/tmp", "alias.json");
    const resolved = join(testProject, ".pi", "ward.json");
    expect(await isSelfProtected(nominal, resolved)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — active identity checks (hardlink/symlink alias)
// ---------------------------------------------------------------------------

describe("isSelfProtected — active identity checks", () => {
  let tempDir: string;

  beforeEach(async () => {
    const base = join(tmpdir(), `pi-ward-self-protect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(base, { recursive: true });
    tempDir = await realpath(base);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns true for a symlink alias whose resolved identity matches an active config", async () => {
    const realConfig = join(tempDir, "ward.json");
    await writeFile(realConfig, "{}");
    const alias = join(tempDir, "alias.json");
    await symlink(realConfig, alias);

    const { stat } = await import("node:fs/promises");
    const st = await stat(realConfig);
    const identities = [{ dev: st.dev, ino: st.ino }];

    const resolvedAlias = await realpath(alias);
    expect(await isSelfProtected(alias, resolvedAlias, identities)).toBe(true);
  });

  it("returns true for a hardlink alias whose identity matches an active config", async () => {
    const { link, stat } = await import("node:fs/promises");
    const realConfig = join(tempDir, "ward.json");
    await writeFile(realConfig, "{}");
    const hardlinkAlias = join(tempDir, "hardlink-alias.json");
    await link(realConfig, hardlinkAlias);

    const st = await stat(realConfig);
    const identities = [{ dev: st.dev, ino: st.ino }];

    // A hardlink has its own independent path — realpath does not rewrite it.
    expect(await isSelfProtected(hardlinkAlias, hardlinkAlias, identities)).toBe(true);
  });

  it("returns false for an unrelated file when identities are active but don't match", async () => {
    const unrelated = join(tempDir, "unrelated.json");
    await writeFile(unrelated, "{}");

    const identities = [{ dev: 999999, ino: 999999 }];

    expect(await isSelfProtected(unrelated, unrelated, identities)).toBe(false);
  });

  it("returns false for a target that doesn't exist, even with active identities", async () => {
    const missing = join(tempDir, "missing.json");
    const identities = [{ dev: 1, ino: 1 }];

    expect(await isSelfProtected(missing, missing, identities)).toBe(false);
  });

  it("fails closed when identity inspection cannot be completed (e.g. permission error)", async () => {
    const restrictedDir = join(tempDir, "restricted");
    await mkdir(restrictedDir);
    const file = join(restrictedDir, "file.json");
    await writeFile(file, "{}");

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Root bypasses permission checks — skip.
      return;
    }

    const { chmod } = await import("node:fs/promises");
    await chmod(restrictedDir, 0o000);
    try {
      const identities = [{ dev: 1, ino: 1 }];
      expect(await isSelfProtected(file, file, identities)).toBe(true);
    } finally {
      await chmod(restrictedDir, 0o755);
    }
  });
});
