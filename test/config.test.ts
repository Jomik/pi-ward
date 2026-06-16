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

import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { evaluate } from "../src/evaluator.js";

const mockHomedir = vi.mocked(homedir);
const mockGetAgentDir = vi.mocked(getAgentDir);

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempBase: string;
let testHome: string;
let testProject: string;

beforeEach(async () => {
  tempBase = join(tmpdir(), `pi-ward-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  testHome = join(tempBase, "home");
  testProject = join(testHome, "projects", "myproject");

  await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
  await mkdir(join(testProject, ".pi"), { recursive: true });

  mockHomedir.mockReturnValue(testHome);
  mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
});

afterEach(async () => {
  await rm(tempBase, { recursive: true, force: true });
});

/** Write a JSON config file, creating parent dirs as needed. */
async function writeConfig(filePath: string, content: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(content), "utf-8");
}

// ---------------------------------------------------------------------------
// Helper to construct a minimal valid config object.
// ---------------------------------------------------------------------------

function cfg(rules: { pattern: string; effect: "allow" | "deny"; operations?: "read" | "write" }[]) {
  return { rules };
}

// ---------------------------------------------------------------------------
// No configs → empty rules
// ---------------------------------------------------------------------------

describe("no configs present", () => {
  it("returns empty rules when no config files exist", async () => {
    const result = await loadConfig(testProject);
    expect(result.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Global config only
// ---------------------------------------------------------------------------

describe("global config only", () => {
  it("loads rules with configDir = homedir", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].configDir).toBe(testHome);
    expect(result.rules[0].effect).toBe("deny");
  });

  it('defaults missing operations to "read"', async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "*.pem", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules[0].operations).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// Project config only
// ---------------------------------------------------------------------------

describe("project config only", () => {
  it("loads rules with configDir = projectRoot", async () => {
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: ".secret/", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].configDir).toBe(testProject);
    expect(result.rules[0].effect).toBe("deny");
  });

  it("preserves explicit operations from the raw rule", async () => {
    await writeConfig(
      join(testProject, ".pi", "ward.json"),
      cfg([{ pattern: ".git/", effect: "deny", operations: "write" }]),
    );

    const result = await loadConfig(testProject);

    expect(result.rules[0].operations).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// Only global + project — ancestor configs are NOT loaded
// ---------------------------------------------------------------------------

describe("only global + project configs are loaded", () => {
  it("loads only global + project rules (ignores ancestor configs)", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));
    // Ancestor config between home and project — should be ignored
    await writeConfig(join(testHome, ".pi", "ward.json"), cfg([{ pattern: "home-level", effect: "deny" }]));
    await writeConfig(join(testHome, "projects", ".pi", "ward.json"), cfg([{ pattern: "mid-level", effect: "deny" }]));
    // Project config — should be loaded
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: "project-level", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules).toHaveLength(2);
    const patterns = result.rules.map((r) => {
      const seg = r.pattern.segments[0];
      return seg && seg.kind === "literal" ? seg.value : null;
    });
    expect(patterns).toEqual(["global", "project-level"]);
  });

  it("configDirs are global (homedir) and project root only", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: "project-level", effect: "deny" }]));

    const result = await loadConfig(testProject);

    const configDirs = result.rules.map((r) => r.configDir);
    expect(configDirs).toEqual([testHome, testProject]);
  });

  it("loads project config even when projectRoot is outside homedir", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));

    const outsideProject = join(tempBase, "other-project");
    await mkdir(join(outsideProject, ".pi"), { recursive: true });
    await writeConfig(join(outsideProject, ".pi", "ward.json"), cfg([{ pattern: "project-level", effect: "deny" }]));

    const result = await loadConfig(outsideProject);

    expect(result.rules).toHaveLength(2);
    const patterns = result.rules.map((r) => {
      const seg = r.pattern.segments[0];
      return seg && seg.kind === "literal" ? seg.value : null;
    });
    expect(patterns).toEqual(["global", "project-level"]);
  });

  it("loads only global when project config is absent", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));
    // No project config written

    const result = await loadConfig(testProject);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].configDir).toBe(testHome);
  });
});

// ---------------------------------------------------------------------------
// Error cases — fail-closed
// ---------------------------------------------------------------------------

describe("invalid JSON", () => {
  it("throws with file path in message", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeFile(configPath, "{ not valid json", "utf-8");

    await expect(loadConfig(testProject)).rejects.toThrow(configPath);
  });
});

describe("schema errors", () => {
  it("throws when rules field is missing", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, {});

    await expect(loadConfig(testProject)).rejects.toThrow(/rules/);
  });

  it("throws when rules is not an array", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: "not-an-array" });

    await expect(loadConfig(testProject)).rejects.toThrow(/rules/);
  });

  it("throws when a rule has no pattern", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: [{ effect: "deny" }] });

    await expect(loadConfig(testProject)).rejects.toThrow(/pattern/);
  });

  it("throws when a rule has no effect", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: [{ pattern: ".env" }] });

    await expect(loadConfig(testProject)).rejects.toThrow(/effect/);
  });

  it("throws when operations contains an invalid value", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: [{ pattern: ".env", effect: "deny", operations: "execute" }] });

    await expect(loadConfig(testProject)).rejects.toThrow(/operations/);
  });
});

describe("invalid pattern syntax", () => {
  it("throws when a rule has an invalid pattern (unanchored with /)", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "foo/bar", effect: "deny" }]));

    await expect(loadConfig(testProject)).rejects.toThrow();
  });

  it("throws when a rule has a pattern with **", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "**.ts", effect: "deny" }]));

    await expect(loadConfig(testProject)).rejects.toThrow();
  });
});

describe("ENOENT — silently skipped", () => {
  it("returns empty rules when all config files are absent", async () => {
    const result = await loadConfig(testProject);
    expect(result.rules).toEqual([]);
  });

  it("loads project-only config when global config is absent", async () => {
    // Only project config exists; global config is absent
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testProject);
    expect(result.rules).toHaveLength(1);
  });
});

describe("unreadable file (EACCES)", () => {
  it("throws when a config file exists but cannot be read", async () => {
    // Running as root can bypass permissions — skip in that case.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }

    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeFile(configPath, '{"rules":[]}', "utf-8");
    await chmod(configPath, 0o000);

    try {
      await expect(loadConfig(testProject)).rejects.toThrow(configPath);
    } finally {
      await chmod(configPath, 0o644);
    }
  });
});

describe("anchored allow pattern with ../", () => {
  it("throws when an allow rule has an anchored pattern starting with ..", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "./../secrets", effect: "allow" }]));

    await expect(loadConfig(testProject)).rejects.toThrow();
  });

  it("throws for a deeply escaping anchored allow pattern", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "./../../secrets", effect: "allow" }]));

    await expect(loadConfig(testProject)).rejects.toThrow();
  });

  it("does not throw for a valid anchored allow pattern", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "./src/", effect: "allow" }]));

    await expect(loadConfig(testProject)).resolves.toBeDefined();
  });

  it("does not throw for an unanchored allow pattern (trust scoped at runtime)", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: ".env*", effect: "allow" }]));

    await expect(loadConfig(testProject)).resolves.toBeDefined();
  });

  it("deny rule with anchored .. pattern does not throw", async () => {
    // Deny rules are not subject to load-time trust scoping.
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "./../secrets", effect: "deny" }]));

    await expect(loadConfig(testProject)).resolves.toBeDefined();
  });

  it("throws when a home-anchored allow rule has '..' as first segment", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/../etc", effect: "allow" }]));

    await expect(loadConfig(testProject)).rejects.toThrow(/can never match within the home directory/);
  });

  it("deny rule with home-anchored .. pattern does not throw", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/../etc", effect: "deny" }]));

    await expect(loadConfig(testProject)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// homeDir stored on rules
// ---------------------------------------------------------------------------

describe("homeDir stored on ParsedRule", () => {
  it("rules carry homeDir from the resolved home directory", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testProject, testHome);

    expect(result.rules[0].homeDir).toBe(testHome);
  });

  it("project config rules also carry homeDir", async () => {
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testProject, testHome);

    expect(result.rules[0].homeDir).toBe(testHome);
  });
});

// ---------------------------------------------------------------------------
// Absolute-anchored patterns
// ---------------------------------------------------------------------------

describe("absolute-anchored patterns", () => {
  it("throws when a non-global config contains an absolute-anchored pattern", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "/tmp/foo/", effect: "allow" }]));

    await expect(loadConfig(testProject)).rejects.toThrow(/absolute-path pattern.*only allowed in the global config/);
  });

  it("loads absolute-anchored pattern successfully in global config", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "/tmp/pi-github-repos/", effect: "allow" }]));

    const result = await loadConfig(testProject);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].pattern.absoluteAnchored).toBe(true);
  });

  it("sets configDir to '/' for absolute-anchored rules in global config", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "/tmp/pi-github-repos/", effect: "allow" }]));

    const result = await loadConfig(testProject);
    expect(result.rules[0].configDir).toBe("/");
  });

  it("includes rule index in absolute-anchored error message", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(
      configPath,
      cfg([
        { pattern: ".env*", effect: "deny" },
        { pattern: "/tmp/foo/", effect: "allow" },
      ]),
    );

    await expect(loadConfig(testProject)).rejects.toThrow(/rule\[1\]/);
  });

  it("resolves symlinks in absolute-anchored pattern prefix at load time", async () => {
    // Create a real directory and a symlink to it
    const realDir = join(tempBase, "real-repos");
    await mkdir(realDir, { recursive: true });
    const linkDir = join(tempBase, "link-repos");
    await symlink(realDir, linkDir);

    // Write a global config using the symlink path
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: `${linkDir}/`, effect: "allow" }]));

    const result = await loadConfig(testProject);
    expect(result.rules).toHaveLength(1);

    // The loaded rule's pattern segments should be derived from the realpath'd form
    const resolvedDir = await realpath(linkDir);
    const expectedSegments = resolvedDir.split(/[/\\]/).filter((s) => s !== "");
    const actualValues = result.rules[0].pattern.segments.map((s) => (s.kind === "literal" ? s.value : null));
    expect(actualValues).toEqual(expectedSegments);
  });
});

// ---------------------------------------------------------------------------
// Global config rejects "./"-anchored patterns
// ---------------------------------------------------------------------------

describe('global config rejects "./"-anchored patterns', () => {
  it('throws when global config contains a "./"-anchored pattern', async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "./src/", effect: "deny" }]));

    await expect(loadConfig(testProject)).rejects.toThrow(/".\/src\/".*not allowed in the global config/);
  });

  it('throws for any rule index in global config with "./" pattern', async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(
      configPath,
      cfg([
        { pattern: ".env*", effect: "deny" },
        { pattern: "./secrets", effect: "deny" },
      ]),
    );

    await expect(loadConfig(testProject)).rejects.toThrow(/rule\[1\]/);
  });

  it('does not throw when global config uses "~/" instead of "./"', async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    await expect(loadConfig(testProject)).resolves.toBeDefined();
  });

  it('allows "./"-anchored patterns in non-global configs', async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "./src/", effect: "deny" }]));

    await expect(loadConfig(testProject)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Home-anchored allow rules outside configDir (issue #8)
// ---------------------------------------------------------------------------

describe("home-anchored allow rules outside configDir", () => {
  it("throws when ~/ allow rule target is structurally outside configDir", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/.ssh/", effect: "allow" }]));

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/can never match within the config directory/);
  });

  it("throws for ~/ allow targeting a sibling directory of configDir", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/other-project/", effect: "allow" }]));

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/can never match within the config directory/);
  });

  it("does not throw when ~/ allow pattern resolves within configDir", async () => {
    // ~/projects/myproject/secrets/ — effectiveRoot is within configDir
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/projects/myproject/secrets/", effect: "allow" }]));

    await expect(loadConfig(testProject, testHome)).resolves.toBeDefined();
  });

  it("does not throw when configDir is within ~/ allow pattern's effective root", async () => {
    // ~/projects/ — configDir (~/projects/myproject) is within effectiveRoot
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/projects/", effect: "allow" }]));

    await expect(loadConfig(testProject, testHome)).resolves.toBeDefined();
  });

  it("does not throw for bare ~/ allow (effectiveRoot = homeDir)", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/", effect: "allow" }]));

    await expect(loadConfig(testProject, testHome)).resolves.toBeDefined();
  });

  it("does not throw when pattern has a wildcard as first segment", async () => {
    // ~/*/.ssh/ — wildcard stops literal extraction, effectiveRoot = homeDir
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/*/.ssh/", effect: "allow" }]));

    await expect(loadConfig(testProject, testHome)).resolves.toBeDefined();
  });

  it("does not throw for ~/ allow in global config", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/.ssh/", effect: "allow" }]));

    await expect(loadConfig(testProject, testHome)).resolves.toBeDefined();
  });

  it("does not throw for ~/ deny rule outside configDir", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    await expect(loadConfig(testProject, testHome)).resolves.toBeDefined();
  });

  it("includes rule index in error message", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(
      configPath,
      cfg([
        { pattern: ".env*", effect: "deny" },
        { pattern: "~/.config/", effect: "allow" },
      ]),
    );

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/rule\[1\]/);
  });
});

// ---------------------------------------------------------------------------
// Home-anchored patterns in config
// ---------------------------------------------------------------------------

describe("home-anchored patterns in config", () => {
  it("parses a ~/  pattern into homeAnchored: true", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    const result = await loadConfig(testProject, testHome);

    expect(result.rules[0].pattern.homeAnchored).toBe(true);
    expect(result.rules[0].pattern.anchored).toBe(false);
  });

  it("home-anchored pattern can appear in a project config", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/notes/", effect: "deny" }]));

    const result = await loadConfig(testProject, testHome);

    expect(result.rules[0].pattern.homeAnchored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Home-anchored patterns — homeDir field and ~/ loading
// ---------------------------------------------------------------------------

describe("home-anchored patterns — homeDir field and ~/ loading", () => {
  it("loaded rules from global config have homeDir field set to homedir()", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].homeDir).toBe(testHome);
  });

  it("loaded rules from non-global configs also have homeDir field set", async () => {
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].homeDir).toBe(testHome);
  });

  it("parses a ~/ pattern into homeAnchored: true", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules[0].pattern.homeAnchored).toBe(true);
    expect(result.rules[0].pattern.anchored).toBe(false);
  });

  it("non-global (project) config with ~/ pattern loads successfully", async () => {
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    await expect(loadConfig(testProject)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// projectRoot condition — project config rejection
// ---------------------------------------------------------------------------

describe("projectRoot in project config is rejected", () => {
  it("throws when a project config rule uses projectRoot", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: "~/other" }],
    });

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(
      /"projectRoot" is only allowed in the global config/,
    );
  });

  it("includes rule index in projectRoot error message", async () => {
    const configPath = join(testProject, ".pi", "ward.json");
    await writeConfig(configPath, {
      rules: [
        { pattern: ".env*", effect: "deny" },
        { pattern: "*.pem", effect: "deny", projectRoot: "~/other" },
      ],
    });

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/rule\[1\]/);
  });
});

// ---------------------------------------------------------------------------
// projectRoot condition — global config loading and resolution
// ---------------------------------------------------------------------------

describe("projectRoot in global config", () => {
  it("rule without projectRoot has projectRoots undefined", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [{ pattern: ".env*", effect: "deny" }],
    });

    const result = await loadConfig(testProject, testHome);

    expect(result.rules[0].projectRoots).toBeUndefined();
  });

  it("resolves ~/... projectRoot relative to homeDir", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: "~/projects/myproject" }],
    });

    const result = await loadConfig(testProject, testHome);

    const expected = await realpath(testProject);
    expect(result.rules[0].projectRoots).toEqual([expected]);
  });

  it("resolves absolute projectRoot via realpath", async () => {
    const realTestProject = await realpath(testProject);

    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: testProject }],
    });

    const result = await loadConfig(testProject, testHome);

    expect(result.rules[0].projectRoots).toEqual([realTestProject]);
  });

  it("resolves array projectRoot into array of resolved paths", async () => {
    const realTestProject = await realpath(testProject);

    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [
        {
          pattern: ".env*",
          effect: "deny",
          projectRoot: ["~/projects/myproject", testProject],
        },
      ],
    });

    const result = await loadConfig(testProject, testHome);

    expect(result.rules[0].projectRoots).toHaveLength(2);
    expect(result.rules[0].projectRoots).toEqual([realTestProject, realTestProject]);
  });

  it("throws when projectRoot value is a relative path (not ~/ or absolute)", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: "relative/path" }],
    });

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/must be an absolute path or start with "~\/"/);
  });

  it("stores normalized path for nonexistent projectRoot (no error, fail-closed)", async () => {
    const nonExistentPath = join(testHome, "projects", "does-not-exist");

    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: nonExistentPath }],
    });

    // Should not throw — nonexistent path is stored as normalized form and simply never matches.
    const result = await loadConfig(testProject, testHome);
    expect(result.rules[0].projectRoots).toBeDefined();
    expect(result.rules[0].projectRoots).toHaveLength(1);
    expect(result.rules[0].projectRoots?.[0]).toContain("does-not-exist");
  });

  it("resolves ~/... projectRoot through a symlink", async () => {
    const realProjectDir = join(testHome, "projects", "real-project");
    await mkdir(realProjectDir, { recursive: true });
    const linkProjectDir = join(testHome, "projects", "link-project");
    await symlink(realProjectDir, linkProjectDir);

    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: "~/projects/link-project" }],
    });

    const result = await loadConfig(testProject, testHome);

    const expectedResolved = await realpath(linkProjectDir);
    expect(result.rules[0].projectRoots).toEqual([expectedResolved]);
  });

  it("rule with projectRoot string stores projectRoots as single-element array", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: testProject }],
    });

    const result = await loadConfig(testProject, testHome);

    expect(Array.isArray(result.rules[0].projectRoots)).toBe(true);
    expect(result.rules[0].projectRoots).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// projectRoot schema validation
// ---------------------------------------------------------------------------

describe("projectRoot schema validation", () => {
  it("throws a schema error mentioning projectRoot when projectRoot is a number", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: 42 }],
    });

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/projectRoot/);
  });

  it("throws a schema error when projectRoot is an empty array", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: [] }],
    });

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/projectRoot/);
  });

  it("throws a schema error when projectRoot is an array containing a non-string", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, {
      rules: [{ pattern: ".env*", effect: "deny", projectRoot: [42] }],
    });

    await expect(loadConfig(testProject, testHome)).rejects.toThrow(/projectRoot/);
  });
});

// ---------------------------------------------------------------------------
// Integration: loadConfig + evaluate with projectRoot-conditioned allow rule
// ---------------------------------------------------------------------------

describe("integration: loadConfig + evaluate with projectRoot-conditioned allow", () => {
  it("matching projectRoot allows access to sibling/shared path outside active project", async () => {
    const sharedLib = join(testHome, "projects", "shared-lib");
    await mkdir(sharedLib, { recursive: true });

    // Global config: allow ~/projects/shared-lib/ only when working in myproject
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [
        {
          pattern: "~/projects/shared-lib/",
          effect: "allow",
          operations: "read",
          projectRoot: "~/projects/myproject",
        },
      ],
    });

    const { rules } = await loadConfig(testProject, testHome);

    // projectRoots are realpath-resolved at load time; use realpath for the evaluate call too
    const resolvedProject = await realpath(testProject);
    const accessPath = join(testHome, "projects", "shared-lib", "src", "utils.ts");

    expect(evaluate(rules, "read", accessPath, resolvedProject).effect).toBe("allow");
  });

  it("non-matching projectRoot: rule is skipped, baseline denies path outside active project", async () => {
    const sharedLib = join(testHome, "projects", "shared-lib");
    await mkdir(sharedLib, { recursive: true });

    const otherProject = join(testHome, "projects", "other-project");
    await mkdir(otherProject, { recursive: true });

    // Same global config — rule scoped to myproject
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), {
      rules: [
        {
          pattern: "~/projects/shared-lib/",
          effect: "allow",
          operations: "read",
          projectRoot: "~/projects/myproject",
        },
      ],
    });

    const { rules } = await loadConfig(otherProject, testHome);

    const resolvedOtherProject = await realpath(otherProject);
    const accessPath = join(testHome, "projects", "shared-lib", "src", "utils.ts");

    // Rule skipped (projectRoot doesn't match otherProject), baseline denies outside-project path
    expect(evaluate(rules, "read", accessPath, resolvedOtherProject)).toEqual({
      effect: "deny",
      source: "baseline",
    });
  });
});
