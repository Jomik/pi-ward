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

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";

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

function cfg(rules: { pattern: string; effect: "allow" | "deny"; operations?: ("read" | "write")[] }[]) {
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

  it("expands missing operations to both read and write", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "*.pem", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules[0].operations).toEqual(["read", "write"]);
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
      cfg([{ pattern: ".git/", effect: "deny", operations: ["write"] }]),
    );

    const result = await loadConfig(testProject);

    expect(result.rules[0].operations).toEqual(["write"]);
  });
});

// ---------------------------------------------------------------------------
// Multiple ancestor configs — correct order (global first)
// ---------------------------------------------------------------------------

describe("multiple ancestor configs", () => {
  it("loads in order: global → home-ancestor → mid-ancestor → project", async () => {
    // Global
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));
    // Home-level ancestor (~/.pi/ward.json)
    await writeConfig(join(testHome, ".pi", "ward.json"), cfg([{ pattern: "home-level", effect: "deny" }]));
    // Mid ancestor (~/projects/.pi/ward.json)
    await writeConfig(join(testHome, "projects", ".pi", "ward.json"), cfg([{ pattern: "mid-level", effect: "deny" }]));
    // Project
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: "project-level", effect: "deny" }]));

    const result = await loadConfig(testProject);

    expect(result.rules).toHaveLength(4);
    // Patterns encoded as literal segments — retrieve the raw string via the segment value
    const patterns = result.rules.map((r) => {
      const seg = r.pattern.segments[0];
      return seg && seg.kind === "literal" ? seg.value : null;
    });
    expect(patterns).toEqual(["global", "home-level", "mid-level", "project-level"]);
  });

  it("sets correct configDir for each ancestor", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));
    await writeConfig(join(testHome, ".pi", "ward.json"), cfg([{ pattern: "home-level", effect: "deny" }]));
    await writeConfig(join(testHome, "projects", ".pi", "ward.json"), cfg([{ pattern: "mid-level", effect: "deny" }]));
    await writeConfig(join(testProject, ".pi", "ward.json"), cfg([{ pattern: "project-level", effect: "deny" }]));

    const result = await loadConfig(testProject);

    const configDirs = result.rules.map((r) => r.configDir);
    expect(configDirs).toEqual([testHome, testHome, join(testHome, "projects"), testProject]);
  });
});

// ---------------------------------------------------------------------------
// projectRoot outside home — only global config loaded
// ---------------------------------------------------------------------------

describe("projectRoot outside home", () => {
  it("loads only global config when projectRoot is outside homedir", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));

    // Use a path that is NOT inside testHome
    const outsideProject = join(tempBase, "other-project");
    await mkdir(outsideProject, { recursive: true });

    const result = await loadConfig(outsideProject);

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
    await writeConfig(configPath, { rules: [{ pattern: ".env", effect: "deny", operations: ["execute"] }] });

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

  it("skips missing ancestor config without throwing", async () => {
    // Only project config exists; ancestor is absent
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
});
