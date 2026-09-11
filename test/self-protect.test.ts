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

/** Convenience: call isSelfProtected with the same path as both nominal and resolved, defaulting to "write". */
async function protectedSamePath(path: string, operation: "read" | "write" = "write"): Promise<boolean> {
  return isSelfProtected(path, path, operation);
}

// ---------------------------------------------------------------------------
// isSelfProtected — project-local .pi/ward.json is NOT structurally protected
// ---------------------------------------------------------------------------

describe("isSelfProtected — project-local .pi/ward.json is not protected", () => {
  it("returns false for a project config path (not structurally protected)", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", "ward.json"))).toBe(false);
  });

  it("returns false for a .pi/ward.json path anywhere in the tree", async () => {
    expect(await protectedSamePath("/some/other/.pi/ward.json")).toBe(false);
  });

  it("returns false for a .pi/ward.json path at the filesystem root level", async () => {
    expect(await protectedSamePath("/.pi/ward.json")).toBe(false);
  });

  it("returns false for .pi/ward.json inside home directory (not the global config path)", async () => {
    expect(await protectedSamePath(join(testHome, ".pi", "ward.json"))).toBe(false);
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

  it("returns false for ward.json nested deeper under .pi/agent/", async () => {
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

describe("isSelfProtected — creation of nonexistent config paths", () => {
  it("returns false for a nonexistent project-local .pi/ward.json path (not structurally protected)", async () => {
    expect(await protectedSamePath("/nonexistent/dir/.pi/ward.json")).toBe(false);
  });

  it("returns true for a nonexistent global config path (exact match, pre-creation)", async () => {
    expect(await protectedSamePath(join(testHome, ".pi", "agent", "ward.json"))).toBe(true);
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

describe("isSelfProtected — nominal path is not sufficient for project config (structural protection removed)", () => {
  it("returns false for a nominal .pi/ward.json path when the resolved path is elsewhere and it isn't the global config or an active identity", async () => {
    const nominal = join(testProject, ".pi", "ward.json");
    const resolved = join("/elsewhere", "real-config.json");
    expect(await isSelfProtected(nominal, resolved, "write")).toBe(false);
  });

  it("returns false for a resolved path that looks like .pi/ward.json when it isn't the global config or an active identity", async () => {
    const nominal = join("/tmp", "alias.json");
    const resolved = join(testProject, ".pi", "ward.json");
    expect(await isSelfProtected(nominal, resolved, "write")).toBe(false);
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
    expect(await isSelfProtected(alias, resolvedAlias, "write", identities)).toBe(true);
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
    expect(await isSelfProtected(hardlinkAlias, hardlinkAlias, "write", identities)).toBe(true);
  });

  it("returns false for an unrelated file when identities are active but don't match", async () => {
    const unrelated = join(tempDir, "unrelated.json");
    await writeFile(unrelated, "{}");

    const identities = [{ dev: 999999, ino: 999999 }];

    expect(await isSelfProtected(unrelated, unrelated, "write", identities)).toBe(false);
  });

  it("returns false for a target that doesn't exist, even with active identities", async () => {
    const missing = join(tempDir, "missing.json");
    const identities = [{ dev: 1, ino: 1 }];

    expect(await isSelfProtected(missing, missing, "write", identities)).toBe(false);
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
      expect(await isSelfProtected(file, file, "write", identities)).toBe(true);
    } finally {
      await chmod(restrictedDir, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — .pi/ward.id (read + write, including pre-creation)
// ---------------------------------------------------------------------------

describe("isSelfProtected — .pi/ward.id predicate (read and write)", () => {
  it("protects .pi/ward.id from writes", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", "ward.id"), "write")).toBe(true);
  });

  it("protects .pi/ward.id from reads", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", "ward.id"), "read")).toBe(true);
  });

  it("protects a nonexistent .pi/ward.id path from both reads and writes (pre-creation)", async () => {
    expect(await protectedSamePath("/nonexistent/dir/.pi/ward.id", "write")).toBe(true);
    expect(await protectedSamePath("/nonexistent/dir/.pi/ward.id", "read")).toBe(true);
  });

  it("does not protect a similarly-named file that isn't ward.id", async () => {
    expect(await protectedSamePath(join(testProject, ".pi", "ward.id.bak"), "read")).toBe(false);
    expect(await protectedSamePath(join(testProject, ".pi", "ward.id.bak"), "write")).toBe(false);
  });

  it("protects .pi/ward.id via the nominal path even when the resolved path is elsewhere (symlinked ancestor)", async () => {
    const nominal = join(testProject, ".pi", "ward.id");
    const resolved = join("/elsewhere", "real-id");
    expect(await isSelfProtected(nominal, resolved, "read")).toBe(true);
    expect(await isSelfProtected(nominal, resolved, "write")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — grants files (write-protected only; reads governed normally)
// ---------------------------------------------------------------------------

describe("isSelfProtected — grants file predicate (write only)", () => {
  it("protects a grants file under the canonical grants directory from writes", async () => {
    const grantsPath = join(testHome, ".pi", "agent", "ward", "some-uuid.grants.json");
    expect(await protectedSamePath(grantsPath, "write")).toBe(true);
  });

  it("does not protect a grants file from reads", async () => {
    const grantsPath = join(testHome, ".pi", "agent", "ward", "some-uuid.grants.json");
    expect(await protectedSamePath(grantsPath, "read")).toBe(false);
  });

  it("protects a nonexistent grants file path from writes (pre-creation)", async () => {
    const grantsPath = join(testHome, ".pi", "agent", "ward", "not-yet-created.grants.json");
    expect(await protectedSamePath(grantsPath, "write")).toBe(true);
  });

  it("does not protect a file in the grants directory that lacks the .grants.json suffix", async () => {
    const otherPath = join(testHome, ".pi", "agent", "ward", "some-uuid.json");
    expect(await protectedSamePath(otherPath, "write")).toBe(false);
  });

  it("does not protect a similarly-named grants file outside the canonical grants directory", async () => {
    const otherPath = join(testHome, "ward", "some-uuid.grants.json");
    expect(await protectedSamePath(otherPath, "write")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — active identity checks, operation-aware (protectRead)
// ---------------------------------------------------------------------------

describe("isSelfProtected — active identity checks respect protectRead", () => {
  let tempDir2: string;

  beforeEach(async () => {
    const base = join(
      tmpdir(),
      `pi-ward-self-protect-protectread-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(base, { recursive: true });
    tempDir2 = await realpath(base);
  });

  afterEach(async () => {
    await rm(tempDir2, { recursive: true, force: true });
  });

  it("a write-only identity (e.g. a config/grants file) does not block reads of its alias", async () => {
    const real = join(tempDir2, "grants.json");
    await writeFile(real, "{}");
    const { stat } = await import("node:fs/promises");
    const st = await stat(real);
    const identities = [{ dev: st.dev, ino: st.ino }]; // protectRead defaults to false/undefined

    const alias = join(tempDir2, "alias.json");
    await symlink(real, alias);
    const resolvedAlias = await realpath(alias);

    expect(await isSelfProtected(alias, resolvedAlias, "read", identities)).toBe(false);
    expect(await isSelfProtected(alias, resolvedAlias, "write", identities)).toBe(true);
  });

  it("a protectRead identity (e.g. ward.id) blocks both reads and writes of its alias", async () => {
    const real = join(tempDir2, "ward-id-file");
    await writeFile(real, "some-uuid");
    const { stat } = await import("node:fs/promises");
    const st = await stat(real);
    const identities = [{ dev: st.dev, ino: st.ino, protectRead: true }];

    const alias = join(tempDir2, "alias-id");
    await symlink(real, alias);
    const resolvedAlias = await realpath(alias);

    expect(await isSelfProtected(alias, resolvedAlias, "read", identities)).toBe(true);
    expect(await isSelfProtected(alias, resolvedAlias, "write", identities)).toBe(true);
  });
});
