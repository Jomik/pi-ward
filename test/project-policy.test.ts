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

import { mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import {
  evaluateCandidate,
  listProjectRules,
  persistCandidate,
  preflightCandidate,
  prepareCandidate,
  readGlobalSnapshot,
} from "../src/project-policy.js";
import type { ParsedRule } from "../src/rules.js";

const mockHomedir = vi.mocked(homedir);
const mockGetAgentDir = vi.mocked(getAgentDir);

let tempBase: string;
let testHome: string;
let testProject: string;
let globalConfigPath: string;

beforeEach(async () => {
  const rawTempBase = join(tmpdir(), `pi-ward-policy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(rawTempBase, { recursive: true });
  // Canonicalize up front so paths built from tempBase already match what
  // resolvePath's internal realpath resolution will produce (avoids symlink
  // mismatches, e.g. macOS /var -> /private/var, against the raw homeDir
  // string used for home-anchored pattern matching).
  tempBase = await realpath(rawTempBase);
  testHome = join(tempBase, "home");
  testProject = join(testHome, "projects", "myproject");
  globalConfigPath = join(testHome, ".pi", "agent", "ward.json");

  await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
  await mkdir(join(testProject, ".pi"), { recursive: true });

  mockHomedir.mockReturnValue(testHome);
  mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
});

afterEach(async () => {
  await rm(tempBase, { recursive: true, force: true });
});

async function writeGlobalConfig(content: unknown): Promise<void> {
  await writeFile(globalConfigPath, JSON.stringify(content), "utf-8");
}

async function projectRulesFor(projectRoot: string): Promise<ParsedRule[]> {
  const { rules } = await loadConfig(projectRoot, testHome);
  // Global rules loaded here are irrelevant to these tests (config starts empty);
  // only project-config rules (configDir === projectRoot) are used as "current project rules".
  return rules.filter((r) => r.configDir === projectRoot);
}

// ---------------------------------------------------------------------------
// prepareCandidate — normalization, directory semantics, rejections
// ---------------------------------------------------------------------------

describe("prepareCandidate", () => {
  it("prefers ~/ spelling when the path is within the home directory", async () => {
    const target = join(testHome, "notes.txt");
    const candidate = await prepareCandidate({
      rawPath: target,
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    expect(candidate.pattern).toBe("~/notes.txt");
  });

  it("falls back to absolute spelling when the path is outside the home directory", async () => {
    const outside = join(tempBase, "outside", "secret.txt");
    await mkdir(join(tempBase, "outside"), { recursive: true });
    await writeFile(outside, "x", "utf-8");

    const candidate = await prepareCandidate({
      rawPath: outside,
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    expect(candidate.pattern.startsWith("/")).toBe(true);
    expect(candidate.pattern).not.toMatch(/^~\//);
  });

  it("does not use ~/ spelling for a sibling directory that merely shares a string prefix", async () => {
    // e.g. a sibling directory named "home-extra" should NOT be treated as inside "home"
    const sibling = `${testHome}-extra`;
    await mkdir(sibling, { recursive: true }).catch(() => {});
    const target = join(sibling, "file.txt");
    await writeFile(target, "x", "utf-8");

    const candidate = await prepareCandidate({
      rawPath: target,
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    expect(candidate.pattern.startsWith("/")).toBe(true);
  });

  it("marks directory intent from a trailing slash", async () => {
    const dir = join(testHome, "secrets");
    await mkdir(dir, { recursive: true });
    const candidate = await prepareCandidate({
      rawPath: `${dir}/`,
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    expect(candidate.directory).toBe(true);
    expect(candidate.pattern.endsWith("/")).toBe(true);
  });

  it("does not mark directory intent without a trailing slash", async () => {
    const file = join(testHome, "notes.txt");
    await writeFile(file, "x", "utf-8");
    const candidate = await prepareCandidate({
      rawPath: file,
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    expect(candidate.directory).toBe(false);
    expect(candidate.pattern.endsWith("/")).toBe(false);
  });

  it("rejects glob input", async () => {
    await expect(
      prepareCandidate({
        rawPath: join(testHome, "*.env"),
        effect: "deny",
        operation: "read",
        projectRoot: testProject,
        homeDir: testHome,
      }),
    ).rejects.toThrow(/Glob patterns are not supported/);
  });

  it("rejects a self-protected write target (global config path)", async () => {
    await expect(
      prepareCandidate({
        rawPath: globalConfigPath,
        effect: "allow",
        operation: "write",
        projectRoot: testProject,
        homeDir: testHome,
      }),
    ).rejects.toThrow(/write-protected/);
  });

  it("rejects a self-protected write target (project .pi/ward.json)", async () => {
    const projectWardJson = join(testProject, ".pi", "ward.json");
    await expect(
      prepareCandidate({
        rawPath: projectWardJson,
        effect: "allow",
        operation: "write",
        projectRoot: testProject,
        homeDir: testHome,
      }),
    ).rejects.toThrow(/write-protected/);
  });

  it("allows a read rule targeting a ward config path (self-protection only blocks write)", async () => {
    const projectWardJson = join(testProject, ".pi", "ward.json");
    const candidate = await prepareCandidate({
      rawPath: projectWardJson,
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    expect(candidate.effect).toBe("deny");
  });

  it("builds a rule ready to append with the projectRoot condition set in readable form", async () => {
    const target = join(testHome, "notes.txt");
    const candidate = await prepareCandidate({
      rawPath: target,
      effect: "allow",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    expect(candidate.rule).toEqual({
      pattern: "~/notes.txt",
      operations: "read",
      effect: "allow",
      projectRoot: "~/projects/myproject",
    });
  });

  it("falls back to absolute spelling for projectRoot when it is outside the home directory", async () => {
    const outsideProject = join(tempBase, "outside-project");
    await mkdir(join(outsideProject, ".pi"), { recursive: true });
    const target = join(testHome, "notes.txt");

    const candidate = await prepareCandidate({
      rawPath: target,
      effect: "allow",
      operation: "read",
      projectRoot: outsideProject,
      homeDir: testHome,
    });
    expect(candidate.rule.projectRoot).toBe(outsideProject);
    expect((candidate.rule.projectRoot as string).startsWith("~/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readGlobalSnapshot — absent vs existing config
// ---------------------------------------------------------------------------

describe("readGlobalSnapshot", () => {
  it("treats a missing global config as { rules: [] }", async () => {
    const snapshot = await readGlobalSnapshot(testHome);
    expect(snapshot.raw).toBeNull();
    expect(snapshot.config).toEqual({ rules: [] });
    expect(snapshot.globalRules).toEqual([]);
  });

  it("reads and parses an existing global config", async () => {
    await writeGlobalConfig({ rules: [{ pattern: "~/.ssh/", effect: "deny" }] });
    const snapshot = await readGlobalSnapshot(testHome);
    expect(snapshot.raw).not.toBeNull();
    expect(snapshot.globalRules).toHaveLength(1);
    expect(snapshot.globalRules[0].rawPattern).toBe("~/.ssh/");
  });
});

// ---------------------------------------------------------------------------
// evaluateCandidate — shadowing, deny-override, supersede disclosure
// ---------------------------------------------------------------------------

describe("evaluateCandidate", () => {
  it("rejects when an earlier global rule already shadows the candidate", async () => {
    await writeGlobalConfig({ rules: [{ pattern: "~/notes.txt", effect: "deny" }] });
    const { globalRules } = await readGlobalSnapshot(testHome);

    const candidate = await prepareCandidate({
      rawPath: join(testHome, "notes.txt"),
      effect: "allow",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });

    const result = evaluateCandidate(candidate, globalRules, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/shadowed by an earlier global rule/);
    }
  });

  it("accepts a candidate with no earlier shadowing rule", async () => {
    const candidate = await prepareCandidate({
      rawPath: join(testHome, "notes.txt"),
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    const result = evaluateCandidate(candidate, [], []);
    expect(result.ok).toBe(true);
  });

  it("rejects a persistent allow when the project config has an explicit deny", async () => {
    await writeFile(
      join(testProject, ".pi", "ward.json"),
      JSON.stringify({ rules: [{ pattern: "secret.txt", effect: "deny" }] }),
      "utf-8",
    );
    const projectRules = await projectRulesFor(testProject);

    const candidate = await prepareCandidate({
      rawPath: join(testHome, "secret.txt"),
      effect: "allow",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });

    const result = evaluateCandidate(candidate, [], projectRules);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Cannot persist allow/);
    }
  });

  it("discloses a currently-matched project rule that a persistent deny will supersede", async () => {
    await writeFile(
      join(testProject, ".pi", "ward.json"),
      JSON.stringify({ rules: [{ pattern: "secret.txt", effect: "allow" }] }),
      "utf-8",
    );
    const projectRules = await projectRulesFor(testProject);

    // Target must be within the project's configDir for its allow rule's trust
    // scoping to apply at all.
    const candidate = await prepareCandidate({
      rawPath: join(testProject, "secret.txt"),
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });

    const result = evaluateCandidate(candidate, [], projectRules);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.supersedes).toEqual({
        pattern: "secret.txt",
        configDir: testProject,
        effect: "allow",
      });
    }
  });

  it("does not disclose supersedes for a persistent allow", async () => {
    const candidate = await prepareCandidate({
      rawPath: join(testHome, "notes.txt"),
      effect: "allow",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    const result = evaluateCandidate(candidate, [], []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.supersedes).toBeUndefined();
    }
  });
});

describe("preflightCandidate", () => {
  it("reads a fresh snapshot and evaluates against it", async () => {
    await writeGlobalConfig({ rules: [] });
    const candidate = await prepareCandidate({
      rawPath: join(testHome, "notes.txt"),
      effect: "deny",
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
    const { snapshot, result } = await preflightCandidate(candidate, [], testHome);
    expect(snapshot.raw).not.toBeNull();
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// persistCandidate — locking, atomicity, permission preservation, cleanup
// ---------------------------------------------------------------------------

describe("persistCandidate", () => {
  async function prep(rawPath: string, effect: "allow" | "deny" = "deny") {
    return prepareCandidate({
      rawPath,
      effect,
      operation: "read",
      projectRoot: testProject,
      homeDir: testHome,
    });
  }

  it("appends the rule and writes the file atomically on success", async () => {
    const candidate = await prep(join(testHome, "notes.txt"));
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    const result = await persistCandidate({
      candidate,
      previousRaw: snapshot.raw,
      projectRules: [],
      homeDir: testHome,
    });

    expect(result.ok).toBe(true);
    const written = JSON.parse(await readFile(globalConfigPath, "utf-8"));
    expect(written.rules).toEqual([
      { pattern: "~/notes.txt", operations: "read", effect: "deny", projectRoot: "~/projects/myproject" },
    ]);
  });

  it("appends without disturbing existing rules or extra fields ($schema)", async () => {
    await writeGlobalConfig({ $schema: "./ward.schema.json", rules: [{ pattern: "~/.ssh/", effect: "deny" }] });
    const candidate = await prep(join(testHome, "notes.txt"));
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    const result = await persistCandidate({
      candidate,
      previousRaw: snapshot.raw,
      projectRules: [],
      homeDir: testHome,
    });

    expect(result.ok).toBe(true);
    const written = JSON.parse(await readFile(globalConfigPath, "utf-8"));
    expect(written.$schema).toBe("./ward.schema.json");
    expect(written.rules).toHaveLength(2);
    expect(written.rules[0]).toEqual({ pattern: "~/.ssh/", effect: "deny" });
  });

  it("uses mode 0600 for a newly created config file", async () => {
    const candidate = await prep(join(testHome, "notes.txt"));
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    await persistCandidate({ candidate, previousRaw: snapshot.raw, projectRules: [], homeDir: testHome });

    const st = await stat(globalConfigPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("preserves the existing file's permission mode", async () => {
    await writeGlobalConfig({ rules: [] });
    await (await import("node:fs/promises")).chmod(globalConfigPath, 0o640);

    const candidate = await prep(join(testHome, "notes.txt"));
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    await persistCandidate({ candidate, previousRaw: snapshot.raw, projectRules: [], homeDir: testHome });

    const st = await stat(globalConfigPath);
    expect(st.mode & 0o777).toBe(0o640);
  });

  it("fails fast when a lock file already exists (lock contention)", async () => {
    const lockPath = `${globalConfigPath}.lock`;
    const handle = await open(lockPath, "wx");
    try {
      const candidate = await prep(join(testHome, "notes.txt"));
      const { snapshot } = await preflightCandidate(candidate, [], testHome);

      const result = await persistCandidate({
        candidate,
        previousRaw: snapshot.raw,
        projectRules: [],
        homeDir: testHome,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/already in progress/);
      }
      // The file must remain untouched.
      await expect(stat(globalConfigPath)).rejects.toThrow();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  });

  it("removes the lock file after a successful persist", async () => {
    const candidate = await prep(join(testHome, "notes.txt"));
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    await persistCandidate({ candidate, previousRaw: snapshot.raw, projectRules: [], homeDir: testHome });

    await expect(stat(`${globalConfigPath}.lock`)).rejects.toThrow();
  });

  it("removes the lock file after a handled failure", async () => {
    const candidate = await prep(join(testHome, "notes.txt"));
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    // Change the file after preparation so persist aborts on the byte-change check.
    await writeGlobalConfig({ rules: [{ pattern: "~/other.txt", effect: "deny" }] });

    const result = await persistCandidate({
      candidate,
      previousRaw: snapshot.raw,
      projectRules: [],
      homeDir: testHome,
    });

    expect(result.ok).toBe(false);
    await expect(stat(`${globalConfigPath}.lock`)).rejects.toThrow();
  });

  it("aborts if the source bytes changed since preparation, leaving the file untouched", async () => {
    await writeGlobalConfig({ rules: [] });
    const candidate = await prep(join(testHome, "notes.txt"));
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    // Concurrent modification after preflight, before persist.
    await writeGlobalConfig({ rules: [{ pattern: "~/other.txt", effect: "deny" }] });

    const result = await persistCandidate({
      candidate,
      previousRaw: snapshot.raw,
      projectRules: [],
      homeDir: testHome,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/changed since this proposal was prepared/);
    }
    const written = JSON.parse(await readFile(globalConfigPath, "utf-8"));
    expect(written.rules).toEqual([{ pattern: "~/other.txt", effect: "deny" }]);
  });

  it("leaves the config untouched when the re-run preflight fails under the lock", async () => {
    await writeGlobalConfig({ rules: [] });
    const candidate = await prep(join(testHome, "notes.txt"), "allow");
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    // A project deny rule appears only now (not part of the byte snapshot, but part of
    // "current project rules" — simulating an out-of-band project change since preparation).
    await writeFile(
      join(testProject, ".pi", "ward.json"),
      JSON.stringify({ rules: [{ pattern: "notes.txt", effect: "deny" }] }),
      "utf-8",
    );
    const projectRules = await projectRulesFor(testProject);

    const result = await persistCandidate({
      candidate,
      previousRaw: snapshot.raw,
      projectRules,
      homeDir: testHome,
    });

    expect(result.ok).toBe(false);
    const written = JSON.parse(await readFile(globalConfigPath, "utf-8"));
    expect(written.rules).toEqual([]);
  });

  it("rejects when the fully-assembled config fails a semantic (not just shape) rule check, leaving the file untouched", async () => {
    // A well-formed-per-schema PreparedCandidate whose final rule pattern is
    // "./"-anchored — structurally forbidden in the global config. Real callers
    // of prepareCandidate never produce such a pattern; tampering with the
    // prepared rule here isolates persistCandidate's own semantic guard (the
    // same load-time rule checks parseConfigRules applies at startup), which
    // WardConfigSchema shape validation alone would not catch.
    const candidate = await prep(join(testHome, "notes.txt"));
    const badCandidate = { ...candidate, rule: { ...candidate.rule, pattern: "./secret.txt" } };
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    const result = await persistCandidate({
      candidate: badCandidate,
      previousRaw: snapshot.raw,
      projectRules: [],
      homeDir: testHome,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not allowed in the global config/);
    }
    await expect(stat(globalConfigPath)).rejects.toThrow();
  });

  it("removes the temp file after a handled failure", async () => {
    await writeGlobalConfig({ rules: [] });
    const candidate = await prep(join(testHome, "notes.txt"), "allow");
    const { snapshot } = await preflightCandidate(candidate, [], testHome);

    // Force the re-run preflight to fail by pre-shadowing with an existing global rule
    // written between preparation and persist would be caught by the byte-change guard first;
    // instead, use a project deny discovered under the lock to trigger the deny-override reject
    // without changing global bytes.
    await writeFile(
      join(testProject, ".pi", "ward.json"),
      JSON.stringify({ rules: [{ pattern: "notes.txt", effect: "deny" }] }),
      "utf-8",
    );
    const projectRules = await projectRulesFor(testProject);

    await persistCandidate({ candidate, previousRaw: snapshot.raw, projectRules, homeDir: testHome });

    const dirEntries = await (await import("node:fs/promises")).readdir(join(testHome, ".pi", "agent"));
    expect(dirEntries.some((f) => f.includes(".tmp-"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listProjectRules — filtering by active projectRoot
// ---------------------------------------------------------------------------

describe("listProjectRules", () => {
  it("returns only global rules whose projectRoots include the active project root", async () => {
    const otherProject = join(testHome, "projects", "other");
    await mkdir(otherProject, { recursive: true });

    await writeGlobalConfig({
      rules: [
        { pattern: "~/a.txt", effect: "deny", projectRoot: testProject },
        { pattern: "~/b.txt", effect: "deny", projectRoot: otherProject },
        { pattern: "~/c.txt", effect: "deny" },
      ],
    });

    const rules = await listProjectRules(testProject, testHome);
    expect(rules).toHaveLength(1);
    expect(rules[0].rawPattern).toBe("~/a.txt");
  });

  it("returns an empty list when the global config is absent", async () => {
    const rules = await listProjectRules(testProject, testHome);
    expect(rules).toEqual([]);
  });
});
