import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before imports that use homedir so vitest can hoist it.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

import { chmod, mkdir, open, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  canonicalGrantsPath,
  createProjectId,
  deleteGrantsFile,
  generateProjectId,
  loadProjectGrantState,
  persistGrantsFile,
  prepareGrantInput,
  projectIdPath,
  readProjectId,
} from "../src/project-grants.js";

const mockHomedir = vi.mocked(homedir);
const mockGetAgentDir = vi.mocked(getAgentDir);

let tempBase: string;
let testHome: string;
let testProject: string;
let grantsDir: string;

beforeEach(async () => {
  const rawTempBase = join(tmpdir(), `pi-ward-grants-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(rawTempBase, { recursive: true });
  tempBase = await realpath(rawTempBase);
  testHome = join(tempBase, "home");
  testProject = join(testHome, "projects", "myproject");
  grantsDir = join(testHome, ".pi", "agent", "ward");

  await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
  await mkdir(join(testProject, ".pi"), { recursive: true });

  mockHomedir.mockReturnValue(testHome);
  mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
});

afterEach(async () => {
  await rm(tempBase, { recursive: true, force: true });
});

describe("projectIdPath", () => {
  it("points at <projectRoot>/.pi/ward.id", () => {
    expect(projectIdPath(testProject)).toBe(join(testProject, ".pi", "ward.id"));
  });
});

describe("readProjectId", () => {
  it("returns null when the file is missing", async () => {
    expect(await readProjectId(testProject)).toBeNull();
  });

  it("reads a valid canonical UUID with no trailing newline", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    await writeFile(projectIdPath(testProject), id, "utf-8");
    expect(await readProjectId(testProject)).toBe(id);
  });

  it("reads a valid canonical UUID with exactly one trailing newline", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    await writeFile(projectIdPath(testProject), `${id}\n`, "utf-8");
    expect(await readProjectId(testProject)).toBe(id);
  });

  it("throws on uppercase UUID content", async () => {
    await writeFile(projectIdPath(testProject), "550E8400-E29B-41D4-A716-446655440000", "utf-8");
    await expect(readProjectId(testProject)).rejects.toThrow(/canonical UUID/);
  });

  it("throws on malformed content", async () => {
    await writeFile(projectIdPath(testProject), "not-a-uuid", "utf-8");
    await expect(readProjectId(testProject)).rejects.toThrow(/canonical UUID/);
  });

  it("throws on content with extra trailing data after the newline", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    await writeFile(projectIdPath(testProject), `${id}\nextra`, "utf-8");
    await expect(readProjectId(testProject)).rejects.toThrow(/canonical UUID/);
  });

  it("throws on an oversized file", async () => {
    await writeFile(projectIdPath(testProject), "a".repeat(1000), "utf-8");
    await expect(readProjectId(testProject)).rejects.toThrow(/too large/);
  });

  it("throws on a symlink even if it points at a valid id file", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const real = join(testProject, ".pi", "real-id");
    await writeFile(real, id, "utf-8");
    await symlink(real, projectIdPath(testProject));
    await expect(readProjectId(testProject)).rejects.toThrow(/not a regular file/);
  });

  it("throws on a directory at the id path", async () => {
    await mkdir(projectIdPath(testProject), { recursive: true });
    await expect(readProjectId(testProject)).rejects.toThrow(/not a regular file/);
  });

  it("throws on an unreadable (permission-denied) id file", async () => {
    // Running as root can bypass permissions — skip in that case.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const path = projectIdPath(testProject);
    await writeFile(path, id, "utf-8");
    await chmod(path, 0o000);
    try {
      await expect(readProjectId(testProject)).rejects.toThrow(path);
    } finally {
      await chmod(path, 0o644);
    }
  });
});

const TEST_ID = "550e8400-e29b-41d4-a716-446655440000";

async function setProjectId(id: string): Promise<void> {
  await writeFile(projectIdPath(testProject), id, "utf-8");
}

function grantsFilePathFor(id: string): string {
  return join(grantsDir, `${id}.grants.json`);
}

describe("loadProjectGrantState", () => {
  it("returns empty id/snapshot/grants/identities when ward.id is missing", async () => {
    const state = await loadProjectGrantState(testProject, testHome);
    expect(state).toEqual({
      id: null,
      raw: null,
      grantsFile: { grants: [] },
      grants: [],
      identities: [],
    });
  });

  it("throws when ward.id is malformed", async () => {
    await writeFile(projectIdPath(testProject), "not-a-uuid", "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow(/canonical UUID/);
  });

  it("returns the id plus a ward.id identity and empty snapshot/grants when the grants file is missing", async () => {
    await setProjectId(TEST_ID);
    const idStat = await stat(projectIdPath(testProject));

    const state = await loadProjectGrantState(testProject, testHome);
    expect(state.id).toBe(TEST_ID);
    expect(state.raw).toBeNull();
    expect(state.grantsFile).toEqual({ grants: [] });
    expect(state.grants).toEqual([]);
    expect(state.identities).toEqual([{ dev: idStat.dev, ino: idStat.ino, protectRead: true }]);
  });

  it("loads and resolves a valid grants file, plus raw bytes and both identities", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    const target = join(testHome, "shared");
    await mkdir(target, { recursive: true });
    const raw = JSON.stringify({ grants: [{ path: "~/shared/", operations: "write" }] });
    await writeFile(grantsFilePathFor(TEST_ID), raw, "utf-8");

    const idStat = await stat(projectIdPath(testProject));
    const grantsStat = await stat(grantsFilePathFor(TEST_ID));

    const state = await loadProjectGrantState(testProject, testHome);
    expect(state.id).toBe(TEST_ID);
    expect(state.raw).toBe(raw);
    expect(state.grantsFile).toEqual({ grants: [{ path: "~/shared/", operations: "write" }] });
    expect(state.grants).toEqual([{ resolvedPath: target, operations: "write", directory: true }]);
    expect(state.identities).toEqual([
      { dev: idStat.dev, ino: idStat.ino, protectRead: true },
      { dev: grantsStat.dev, ino: grantsStat.ino },
    ]);
  });

  it("defaults operations to read when omitted", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    const target = join(testHome, "readonly.txt");
    await writeFile(target, "x", "utf-8");
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [{ path: "~/readonly.txt" }] }), "utf-8");

    const state = await loadProjectGrantState(testProject, testHome);
    expect(state.grants).toEqual([{ resolvedPath: target, operations: "read", directory: false }]);
  });

  it("throws on a malformed grants file (invalid JSON)", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    await writeFile(grantsFilePathFor(TEST_ID), "not json", "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow(/Invalid JSON/);
  });

  it("throws on a grants file failing schema validation (invalid operations, unknown properties)", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    await writeFile(
      grantsFilePathFor(TEST_ID),
      JSON.stringify({ grants: [{ path: "~/x", operations: "bad" }] }),
      "utf-8",
    );
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow();

    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [], extra: true }), "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow();

    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [{ path: "~/x", extra: true }] }), "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow();

    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({}), "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow();
  });

  it("throws on a relative grant path", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [{ path: "relative/path" }] }), "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow(/must be an absolute path/);
  });

  it("throws on a grant path containing glob characters", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [{ path: "~/*.env" }] }), "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow(/glob characters/);
  });

  it("throws on a broken (dangling symlink) grant target", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    const dangling = join(testHome, "dangling");
    await symlink(join(testHome, "does-not-exist"), dangling);
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [{ path: "~/dangling" }] }), "utf-8");
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow(/cannot be resolved/);
  });

  it("throws when the grants file itself is a symlink escaping the canonical grants directory", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    const outside = join(testHome, "outside.grants.json");
    await writeFile(outside, JSON.stringify({ grants: [] }), "utf-8");
    await symlink(outside, grantsFilePathFor(TEST_ID));
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow(
      /escapes the canonical grants directory/,
    );
  });

  it("throws when the grants file itself is a symlink to a regular file within the grants directory", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    const internal = join(grantsDir, "other-file.json");
    await writeFile(internal, JSON.stringify({ grants: [] }), "utf-8");
    await symlink(internal, grantsFilePathFor(TEST_ID));
    await expect(loadProjectGrantState(testProject, testHome)).rejects.toThrow(/is a symlink, not a regular file/);
  });
});

describe("persistGrantsFile", () => {
  it("creates the grants directory (mode 0700) and writes the file (mode 0600)", async () => {
    const result = await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [] },
      previousRaw: null,
      homeDir: testHome,
    });
    expect(result.ok).toBe(true);

    const dirStat = await stat(grantsDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const fileStat = await stat(grantsFilePathFor(TEST_ID));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(grantsFilePathFor(TEST_ID), "utf-8"))).toEqual({ grants: [] });
  });

  it("tightens a pre-existing, more permissive grants directory to mode 0700", async () => {
    await mkdir(grantsDir, { recursive: true, mode: 0o755 });
    await chmod(grantsDir, 0o755);

    const result = await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [] },
      previousRaw: null,
      homeDir: testHome,
    });
    expect(result.ok).toBe(true);

    const dirStat = await stat(grantsDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("writes a valid grant entry", async () => {
    const target = join(testHome, "shared");
    await mkdir(target, { recursive: true });
    const result = await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [{ path: "~/shared/", operations: "write" }] },
      previousRaw: null,
      homeDir: testHome,
    });
    expect(result.ok).toBe(true);
    const written = JSON.parse(await readFile(grantsFilePathFor(TEST_ID), "utf-8"));
    expect(written).toEqual({ grants: [{ path: "~/shared/", operations: "write" }] });
  });

  it("rejects an invalid grant entry, leaving the file untouched", async () => {
    const result = await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [{ path: "relative/path" }] },
      previousRaw: null,
      homeDir: testHome,
    });
    expect(result.ok).toBe(false);
    await expect(stat(grantsFilePathFor(TEST_ID))).rejects.toThrow();
  });

  it("preserves the existing file's permission mode", async () => {
    await mkdir(grantsDir, { recursive: true });
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [] }), "utf-8");
    await chmod(grantsFilePathFor(TEST_ID), 0o640);

    const result = await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [] },
      previousRaw: JSON.stringify({ grants: [] }),
      homeDir: testHome,
    });
    expect(result.ok).toBe(true);
    const st = await stat(grantsFilePathFor(TEST_ID));
    expect(st.mode & 0o777).toBe(0o640);
  });

  it("strips group/other write bits from an existing mode", async () => {
    await mkdir(grantsDir, { recursive: true });
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [] }), "utf-8");
    // 0666 has group/other write bits, which must always be stripped from
    // the replacement file regardless of the existing file's mode.
    await chmod(grantsFilePathFor(TEST_ID), 0o666);

    const result = await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [] },
      previousRaw: JSON.stringify({ grants: [] }),
      homeDir: testHome,
    });
    expect(result.ok).toBe(true);
    const st = await stat(grantsFilePathFor(TEST_ID));
    expect(st.mode & 0o777).toBe(0o644);
  });

  it("aborts if the source bytes changed since previousRaw was captured", async () => {
    await mkdir(grantsDir, { recursive: true });
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [] }), "utf-8");

    const result = await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [] },
      previousRaw: JSON.stringify({ grants: [{ path: "~/other" }] }), // stale
      homeDir: testHome,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/changed since this write was prepared/);
    }
  });

  it("fails fast when a lock file already exists", async () => {
    await mkdir(grantsDir, { recursive: true });
    const lockPath = `${grantsFilePathFor(TEST_ID)}.lock`;
    const handle = await open(lockPath, "wx");
    try {
      const result = await persistGrantsFile({
        id: TEST_ID,
        grantsFile: { grants: [] },
        previousRaw: null,
        homeDir: testHome,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/already in progress/);
      }
      await expect(stat(grantsFilePathFor(TEST_ID))).rejects.toThrow();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  });

  it("removes the lock file after a successful persist", async () => {
    await persistGrantsFile({ id: TEST_ID, grantsFile: { grants: [] }, previousRaw: null, homeDir: testHome });
    await expect(stat(`${grantsFilePathFor(TEST_ID)}.lock`)).rejects.toThrow();
  });

  it("removes the lock file and temp file after a handled failure", async () => {
    await persistGrantsFile({
      id: TEST_ID,
      grantsFile: { grants: [{ path: "relative/path" }] },
      previousRaw: null,
      homeDir: testHome,
    });
    await expect(stat(`${grantsFilePathFor(TEST_ID)}.lock`)).rejects.toThrow();
    const entries = await readdir(grantsDir);
    expect(entries.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("rejects an invalid project id", async () => {
    const result = await persistGrantsFile({
      id: "not-a-uuid",
      grantsFile: { grants: [] },
      previousRaw: null,
      homeDir: testHome,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Invalid project id/);
    }
  });
});

describe("generateProjectId", () => {
  it("returns a canonical lowercase UUID without writing anything", async () => {
    const id = generateProjectId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await readProjectId(testProject)).toBeNull();
  });

  it("returns distinct ids across calls", () => {
    expect(generateProjectId()).not.toBe(generateProjectId());
  });
});

describe("createProjectId", () => {
  it("creates ward.id exclusively with mode 0600", async () => {
    const id = await createProjectId(testProject, TEST_ID);
    expect(id).toBe(TEST_ID);
    expect(await readProjectId(testProject)).toBe(TEST_ID);
    const st = await stat(projectIdPath(testProject));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("rejects a malformed caller-supplied id", async () => {
    await expect(createProjectId(testProject, "not-a-uuid")).rejects.toThrow(/Invalid project id/);
    expect(await readProjectId(testProject)).toBeNull();
  });

  it("is idempotent when the same id already exists (race winner)", async () => {
    await setProjectId(TEST_ID);
    const id = await createProjectId(testProject, TEST_ID);
    expect(id).toBe(TEST_ID);
    expect(await readFile(projectIdPath(testProject), "utf-8")).toBe(TEST_ID);
  });

  it("fails without overwriting when a different id already exists", async () => {
    const other = "11111111-1111-1111-1111-111111111111";
    await setProjectId(other);
    await expect(createProjectId(testProject, TEST_ID)).rejects.toThrow(/already contains a different id/);
    expect(await readProjectId(testProject)).toBe(other);
  });

  it("fails without overwriting when a malformed id already exists", async () => {
    await writeFile(projectIdPath(testProject), "not-a-uuid", "utf-8");
    await expect(createProjectId(testProject, TEST_ID)).rejects.toThrow(/canonical UUID/);
    expect(await readFile(projectIdPath(testProject), "utf-8")).toBe("not-a-uuid");
  });
});

describe("canonicalGrantsPath", () => {
  it("resolves to <grantsDir>/<id>.grants.json even when the file does not yet exist", async () => {
    const path = await canonicalGrantsPath(TEST_ID);
    expect(path).toBe(grantsFilePathFor(TEST_ID));
  });

  it("throws on an invalid id", async () => {
    await expect(canonicalGrantsPath("not-a-uuid")).rejects.toThrow(/Invalid project id/);
  });

  it("throws when an existing directory occupies the grants file path", async () => {
    await mkdir(grantsFilePathFor(TEST_ID), { recursive: true });
    await expect(canonicalGrantsPath(TEST_ID)).rejects.toThrow(/not a regular file/);
  });
});

describe("prepareGrantInput", () => {
  it("rejects a glob path", async () => {
    await expect(prepareGrantInput("~/*.env", "read", testProject, testHome)).rejects.toThrow(/glob characters/);
  });

  it("resolves a relative input path against the project root", async () => {
    const outsideRoot = join(tempBase, "outside-project");
    const target = join(outsideRoot, "src", "file.ts");
    await mkdir(join(outsideRoot, "src"), { recursive: true });
    await writeFile(target, "x", "utf-8");

    const result = await prepareGrantInput("src/file.ts", "read", outsideRoot, testHome);
    expect(result.parsed.resolvedPath).toBe(target);
    expect(result.parsed.directory).toBe(false);
    expect(result.grant.path).toBe(target); // outside home => canonical absolute
  });

  it("persists a target under home as an equivalent ~/ path", async () => {
    const target = join(testHome, "shared", "file.txt");
    await mkdir(join(testHome, "shared"), { recursive: true });
    await writeFile(target, "x", "utf-8");

    const result = await prepareGrantInput(target, "write", testProject, testHome);
    expect(result.grant.path).toBe("~/shared/file.txt");
    expect(result.grant.operations).toBe("write");
    expect(result.parsed).toEqual({ resolvedPath: target, operations: "write", directory: false });
  });

  it("preserves trailing-slash directory intent", async () => {
    const target = join(testHome, "shared");
    await mkdir(target, { recursive: true });

    const result = await prepareGrantInput(`${target}/`, "read", testProject, testHome);
    expect(result.parsed.directory).toBe(true);
    expect(result.grant.path.endsWith("/")).toBe(true);
  });

  it("rejects an unresolved (broken symlink) target", async () => {
    const dangling = join(testHome, "dangling");
    await symlink(join(testHome, "does-not-exist"), dangling);
    await expect(prepareGrantInput(dangling, "read", testProject, testHome)).rejects.toThrow(/cannot be resolved/);
  });

  it("treats an existing directory as recursive even without a trailing slash", async () => {
    const target = join(testHome, "shared-dir");
    await mkdir(target, { recursive: true });

    const result = await prepareGrantInput(target, "read", testProject, testHome);
    expect(result.parsed.directory).toBe(true);
    expect(result.grant.path.endsWith("/")).toBe(true);
  });

  it("rejects a self-protected target (ward.id)", async () => {
    const target = projectIdPath(testProject);
    await writeFile(target, "550e8400-e29b-41d4-a716-446655440000", "utf-8");

    await expect(prepareGrantInput(target, "read", testProject, testHome)).rejects.toThrow(/protected/i);
  });
});

describe("deleteGrantsFile", () => {
  it("removes the grants file when previousRaw matches, retaining ward.id", async () => {
    await setProjectId(TEST_ID);
    await mkdir(grantsDir, { recursive: true });
    const raw = JSON.stringify({ grants: [] });
    await writeFile(grantsFilePathFor(TEST_ID), raw, "utf-8");

    const result = await deleteGrantsFile({ id: TEST_ID, previousRaw: raw });
    expect(result.ok).toBe(true);
    await expect(stat(grantsFilePathFor(TEST_ID))).rejects.toThrow();
    expect(await readProjectId(testProject)).toBe(TEST_ID);
  });

  it("fails when the expected grants file does not exist", async () => {
    const result = await deleteGrantsFile({ id: TEST_ID, previousRaw: JSON.stringify({ grants: [] }) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not exist/);
    }
  });

  it("aborts (stale) if the file's raw bytes changed since previousRaw was captured", async () => {
    await mkdir(grantsDir, { recursive: true });
    await writeFile(grantsFilePathFor(TEST_ID), JSON.stringify({ grants: [] }), "utf-8");

    const result = await deleteGrantsFile({
      id: TEST_ID,
      previousRaw: JSON.stringify({ grants: [{ path: "~/other" }] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/changed since this delete was prepared/);
    }
    await expect(stat(grantsFilePathFor(TEST_ID))).resolves.toBeDefined();
  });

  it("fails fast when a lock file already exists", async () => {
    await mkdir(grantsDir, { recursive: true });
    const raw = JSON.stringify({ grants: [] });
    await writeFile(grantsFilePathFor(TEST_ID), raw, "utf-8");
    const lockPath = `${grantsFilePathFor(TEST_ID)}.lock`;
    const handle = await open(lockPath, "wx");
    try {
      const result = await deleteGrantsFile({ id: TEST_ID, previousRaw: raw });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/already in progress/);
      }
      await expect(stat(grantsFilePathFor(TEST_ID))).resolves.toBeDefined();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  });

  it("removes the lock file after a successful delete", async () => {
    await mkdir(grantsDir, { recursive: true });
    const raw = JSON.stringify({ grants: [] });
    await writeFile(grantsFilePathFor(TEST_ID), raw, "utf-8");

    await deleteGrantsFile({ id: TEST_ID, previousRaw: raw });
    await expect(stat(`${grantsFilePathFor(TEST_ID)}.lock`)).rejects.toThrow();
  });

  it("removes the lock file after a handled failure (missing file)", async () => {
    await deleteGrantsFile({ id: TEST_ID, previousRaw: JSON.stringify({ grants: [] }) });
    await expect(stat(`${grantsFilePathFor(TEST_ID)}.lock`)).rejects.toThrow();
  });
});
