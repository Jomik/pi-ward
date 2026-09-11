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

const mockHomedir = vi.mocked(homedir);
const mockGetAgentDir = vi.mocked(getAgentDir);

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempBase: string;
let testHome: string;

beforeEach(async () => {
  tempBase = join(tmpdir(), `pi-ward-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  testHome = join(tempBase, "home");

  await mkdir(join(testHome, ".pi", "agent"), { recursive: true });

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
// No config present → empty rules
// ---------------------------------------------------------------------------

describe("no config present", () => {
  it("returns empty rules when no config file exists", async () => {
    const result = await loadConfig(testHome);
    expect(result.rules).toEqual([]);
  });

  it("returns no protected identities when no config file exists", async () => {
    const result = await loadConfig(testHome);
    expect(result.protectedIdentities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

describe("global config", () => {
  it("loads rules with configDir = homedir", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testHome);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].configDir).toBe(testHome);
    expect(result.rules[0].effect).toBe("deny");
  });

  it("returns the global config's on-disk identity in protectedIdentities", async () => {
    const globalConfigPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(globalConfigPath, cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testHome);

    const { stat } = await import("node:fs/promises");
    const st = await stat(globalConfigPath);
    expect(result.protectedIdentities).toEqual([{ dev: st.dev, ino: st.ino }]);
  });

  it('defaults missing operations to "read"', async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "*.pem", effect: "deny" }]));

    const result = await loadConfig(testHome);

    expect(result.rules[0].operations).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// Project-local `<project>/.pi/ward.json` is ignored, not loaded
// ---------------------------------------------------------------------------

describe("project-local ward.json is not loaded", () => {
  it("ignores a project-local .pi/ward.json without error", async () => {
    const projectDir = join(tempBase, "project");
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeConfig(join(projectDir, ".pi", "ward.json"), cfg([{ pattern: "project-level", effect: "deny" }]));

    const result = await loadConfig(testHome);

    expect(result.rules).toEqual([]);
    expect(result.protectedIdentities).toEqual([]);
  });

  it("loads only the global config when both global and project-local configs exist", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "global", effect: "deny" }]));

    const projectDir = join(tempBase, "project");
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeConfig(join(projectDir, ".pi", "ward.json"), cfg([{ pattern: "project-level", effect: "deny" }]));

    const result = await loadConfig(testHome);

    expect(result.rules).toHaveLength(1);
    const seg = result.rules[0].pattern.segments[0];
    expect(seg && seg.kind === "literal" ? seg.value : null).toBe("global");
  });
});

// ---------------------------------------------------------------------------
// Error cases — fail-closed
// ---------------------------------------------------------------------------

describe("invalid JSON", () => {
  it("throws with file path in message", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeFile(configPath, "{ not valid json", "utf-8");

    await expect(loadConfig(testHome)).rejects.toThrow(configPath);
  });
});

describe("schema errors", () => {
  it("throws when rules field is missing", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, {});

    await expect(loadConfig(testHome)).rejects.toThrow(/rules/);
  });

  it("throws when rules is not an array", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: "not-an-array" });

    await expect(loadConfig(testHome)).rejects.toThrow(/rules/);
  });

  it("throws when a rule has no pattern", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: [{ effect: "deny" }] });

    await expect(loadConfig(testHome)).rejects.toThrow(/pattern/);
  });

  it("throws when a rule has no effect", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: [{ pattern: ".env" }] });

    await expect(loadConfig(testHome)).rejects.toThrow(/effect/);
  });

  it("throws when operations contains an invalid value", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: [{ pattern: ".env", effect: "deny", operations: "execute" }] });

    await expect(loadConfig(testHome)).rejects.toThrow(/operations/);
  });

  it("throws when a rule has a projectRoot property (unknown/removed field)", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, { rules: [{ pattern: ".env", effect: "deny", projectRoot: "~/some/project" }] });

    await expect(loadConfig(testHome)).rejects.toThrow();
  });
});

describe("invalid pattern syntax", () => {
  it("loads a valid multi-segment unanchored pattern (unanchored with /)", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "foo/bar", effect: "deny" }]));

    await expect(loadConfig(testHome)).resolves.toBeDefined();
  });

  it("throws when a rule has a pattern with **", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "**.ts", effect: "deny" }]));

    await expect(loadConfig(testHome)).rejects.toThrow();
  });
});

describe("ENOENT — silently skipped", () => {
  it("returns empty rules when the config file is absent", async () => {
    const result = await loadConfig(testHome);
    expect(result.rules).toEqual([]);
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
      await expect(loadConfig(testHome)).rejects.toThrow(configPath);
    } finally {
      await chmod(configPath, 0o644);
    }
  });
});

describe("global config rejects './'-anchored patterns", () => {
  it('throws when global config contains a "./"-anchored pattern', async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "./src/", effect: "deny" }]));

    await expect(loadConfig(testHome)).rejects.toThrow(/not supported.*"\.\/src\/"/);
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

    await expect(loadConfig(testHome)).rejects.toThrow(/not supported/);
  });

  it('does not throw when global config uses "~/" instead of "./"', async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    await expect(loadConfig(testHome)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Anchored allow pattern with ../ (load-time trust checks)
// ---------------------------------------------------------------------------

describe("anchored allow pattern with ../", () => {
  it("throws when a home-anchored allow rule has '..' as first segment", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/../etc", effect: "allow" }]));

    await expect(loadConfig(testHome)).rejects.toThrow(/can never match within the home directory/);
  });

  it("deny rule with home-anchored .. pattern does not throw", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/../etc", effect: "deny" }]));

    await expect(loadConfig(testHome)).resolves.toBeDefined();
  });

  it("does not throw for an unanchored allow pattern", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: ".env*", effect: "allow" }]));

    await expect(loadConfig(testHome)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// homeDir stored on rules
// ---------------------------------------------------------------------------

describe("homeDir stored on ParsedRule", () => {
  it("rules carry homeDir from the resolved home directory", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: ".env*", effect: "deny" }]));

    const result = await loadConfig(testHome);

    expect(result.rules[0].homeDir).toBe(testHome);
  });
});

// ---------------------------------------------------------------------------
// Absolute-anchored patterns
// ---------------------------------------------------------------------------

describe("absolute-anchored patterns", () => {
  it("loads absolute-anchored pattern successfully in global config", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "/tmp/pi-github-repos/", effect: "allow" }]));

    const result = await loadConfig(testHome);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].pattern.absoluteAnchored).toBe(true);
  });

  it("sets configDir to '/' for absolute-anchored rules in global config", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "/tmp/pi-github-repos/", effect: "allow" }]));

    const result = await loadConfig(testHome);
    expect(result.rules[0].configDir).toBe("/");
  });

  it("includes rule index in error message", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(
      configPath,
      cfg([
        { pattern: ".env*", effect: "deny" },
        { pattern: ".secrets", effect: "deny", operations: "execute" as "read" },
      ]),
    );

    await expect(loadConfig(testHome)).rejects.toThrow(/\/rules\/1/);
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

    const result = await loadConfig(testHome);
    expect(result.rules).toHaveLength(1);

    // The loaded rule's pattern segments should be derived from the realpath'd form
    const resolvedDir = await realpath(linkDir);
    const expectedSegments = resolvedDir.split(/[/\\]/).filter((s) => s !== "");
    const actualValues = result.rules[0].pattern.segments.map((s) => (s.kind === "literal" ? s.value : null));
    expect(actualValues).toEqual(expectedSegments);
  });
});

// ---------------------------------------------------------------------------
// Unanchored multi-segment patterns
// ---------------------------------------------------------------------------

describe("unanchored multi-segment patterns in config", () => {
  it("loads ordered .pi/ exception rules (allow specific files, deny the rest)", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(
      configPath,
      cfg([
        { pattern: ".pi/PLAN.md", effect: "allow", operations: "write" },
        { pattern: ".pi/DESIGN.md", effect: "allow", operations: "write" },
        { pattern: ".pi/", effect: "deny", operations: "write" },
      ]),
    );

    const result = await loadConfig(testHome);

    expect(result.rules).toHaveLength(3);
    expect(result.rules[0].pattern.segments).toEqual([
      { kind: "literal", value: ".pi" },
      { kind: "literal", value: "PLAN.md" },
    ]);
    expect(result.rules[0].pattern.directory).toBe(false);
    expect(result.rules[2].pattern.segments).toEqual([{ kind: "literal", value: ".pi" }]);
    expect(result.rules[2].pattern.directory).toBe(true);
  });

  it("does not throw for an unanchored multi-segment allow pattern (trust scoped at runtime)", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: ".pi/PLAN.md", effect: "allow", operations: "write" }]));

    await expect(loadConfig(testHome)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Home-anchored patterns in config
// ---------------------------------------------------------------------------

describe("home-anchored patterns in config", () => {
  it("parses a ~/ pattern into homeAnchored: true", async () => {
    const configPath = join(testHome, ".pi", "agent", "ward.json");
    await writeConfig(configPath, cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    const result = await loadConfig(testHome);

    expect(result.rules[0].pattern.homeAnchored).toBe(true);
    expect(result.rules[0].pattern.absoluteAnchored).toBe(false);
  });

  it("loaded rules from global config have homeDir field set to homedir()", async () => {
    await writeConfig(join(testHome, ".pi", "agent", "ward.json"), cfg([{ pattern: "~/.ssh/", effect: "deny" }]));

    const result = await loadConfig(testHome);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].homeDir).toBe(testHome);
  });
});
