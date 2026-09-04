import { link, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guard } from "../src/guard.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";
import type { ProtectedIdentity } from "../src/self-protect.js";

let tempDir: string;
let projectRoot: string;
let outsideDir: string;

beforeEach(async () => {
  const base = join(tmpdir(), `pi-ward-integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(base, "project"), { recursive: true });
  await mkdir(join(base, "outside"), { recursive: true });
  // Use realpath so macOS /tmp → /private/tmp is resolved.
  tempDir = await realpath(base);
  projectRoot = join(tempDir, "project");
  outsideDir = join(tempDir, "outside");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeRule(
  pattern: string,
  effect: "allow" | "deny",
  configDir: string,
  operations?: "read" | "write",
  homeDir?: string,
): ParsedRule {
  return {
    pattern: parsePattern(pattern),
    rawPattern: pattern,
    operations: operations ?? "read",
    effect,
    configDir,
    homeDir: homeDir ?? configDir,
  };
}

// ---------------------------------------------------------------------------
// Baseline — no rules
// ---------------------------------------------------------------------------

describe("baseline — no rules", () => {
  it("allows read within project root", async () => {
    const file = join(projectRoot, "index.ts");
    await writeFile(file, "");

    const result = await guard("read", [file], "read", [], projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("allows write within project root", async () => {
    const file = join(projectRoot, "output.txt");
    await writeFile(file, "");

    const result = await guard("write", [file], "write", [], projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("denies read outside project root", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");

    const result = await guard("read", [file], "read", [], projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toMatch(/read/);
    }
  });
});

// ---------------------------------------------------------------------------
// Self-protection
// ---------------------------------------------------------------------------

describe("self-protection", () => {
  it("denies write to a project ward config file", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    const result = await guard("write", [wardConfig], "write", [], projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toMatch(/ward config/i);
    }
  });

  it("denies write to any .pi/ward.json path, even outside the project", async () => {
    const piDir = join(outsideDir, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    const rules: ParsedRule[] = [makeRule(`${outsideDir}/`, "allow", "/", "write", tempDir)];
    const result = await guard("write", [wardConfig], "write", rules, projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/ward config/i);
    }
  });

  it("allows read of a ward config file (only writes are blocked)", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    const result = await guard("read", [wardConfig], "read", [], projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("absolute-anchored allow rule cannot bypass write-protection of config files", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    // An absolute-allow rule that covers the config file's directory
    const resolvedProject = await realpath(projectRoot);
    const rules: ParsedRule[] = [
      {
        pattern: parsePattern(`${resolvedProject}/`),
        rawPattern: `${resolvedProject}/`,
        operations: "write",
        effect: "allow",
        configDir: "/",
        homeDir: tempDir,
      },
    ];

    const result = await guard("write", [wardConfig], "write", rules, projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/ward config/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Self-protection — active identity aliasing (symlink/hardlink)
// ---------------------------------------------------------------------------

describe("self-protection — active identity aliasing", () => {
  async function identityOf(path: string): Promise<ProtectedIdentity> {
    const st = await stat(path);
    return { dev: st.dev, ino: st.ino };
  }

  it("denies write via a direct symlink alias to an active loaded config", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    const identities = [await identityOf(wardConfig)];

    // Alias lives elsewhere and does not structurally look like .pi/ward.json.
    const alias = join(outsideDir, "alias.json");
    await symlink(wardConfig, alias);

    const result = await guard("write", [alias], "write", [], projectRoot, undefined, identities);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/ward config/i);
    }
  });

  it("denies write via a hardlink alias to an active loaded config", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    const identities = [await identityOf(wardConfig)];

    const hardlinkAlias = join(outsideDir, "hardlink-alias.json");
    await link(wardConfig, hardlinkAlias);

    const result = await guard("write", [hardlinkAlias], "write", [], projectRoot, undefined, identities);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/ward config/i);
    }
  });

  it("does not block an unrelated ward.json-named file that isn't loaded or aliased", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');
    const identities = [await identityOf(wardConfig)];

    // A completely unrelated file, not matching the structural predicate and
    // not sharing identity with any active config.
    const unrelated = join(outsideDir, "unrelated-notes.txt");
    await writeFile(unrelated, "just notes");

    const rules: ParsedRule[] = [makeRule(`${outsideDir}/`, "allow", "/", "write", tempDir)];
    const result = await guard("write", [unrelated], "write", rules, projectRoot, undefined, identities);

    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule: deny .env files
// ---------------------------------------------------------------------------

describe("rule: deny .env files", () => {
  it("blocks read of .env.local when a deny rule matches", async () => {
    const envFile = join(projectRoot, ".env.local");
    await writeFile(envFile, "SECRET=foo");

    const rules: ParsedRule[] = [makeRule(".env*", "deny", projectRoot, "read")];

    const result = await guard("read", [envFile], "read", rules, projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toMatch(/read/);
    }
  });

  it("blocks write of .env.local when a deny rule matches", async () => {
    const envFile = join(projectRoot, ".env.local");
    await writeFile(envFile, "SECRET=bar");

    const rules: ParsedRule[] = [makeRule(".env*", "deny", projectRoot)];

    const result = await guard("write", [envFile], "write", rules, projectRoot);

    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule: allow read outside project (global-style config)
// ---------------------------------------------------------------------------

describe("rule: allow read outside project root", () => {
  it("allows read of file outside project when a global-style rule permits it", async () => {
    const file = join(outsideDir, "allowed.txt");
    await writeFile(file, "data");

    // configDir = / simulates a global absolute-anchored allow rule.
    const rules: ParsedRule[] = [makeRule(`${outsideDir}/`, "allow", "/", "read", tempDir)];

    const result = await guard("read", [file], "read", rules, projectRoot);

    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Broken symlink
// ---------------------------------------------------------------------------

describe("broken symlink", () => {
  it("denies access to a dangling symlink", async () => {
    const link = join(projectRoot, "broken-link.txt");
    await symlink(join(projectRoot, "nonexistent.txt"), link);

    const result = await guard("read", [link], "read", [], projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toMatch(/broken symlink/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool name variants (grep, find)
// ---------------------------------------------------------------------------

describe("toolName variants", () => {
  it("guard with toolName 'grep' and operation 'read' allows access within project root", async () => {
    const file = join(projectRoot, "src", "main.ts");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(file, "");

    const result = await guard("grep", [file], "read", [], projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("guard with toolName 'grep' and operation 'read' blocks access outside project root", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");

    const result = await guard("grep", [file], "read", [], projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toContain("grep");
      expect(result.reason).toContain("read");
    }
  });

  it("guard with toolName 'find' and operation 'read' allows access within project root", async () => {
    const result = await guard("find", [projectRoot], "read", [], projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("guard with toolName 'find' and operation 'read' blocks access outside project root", async () => {
    const result = await guard("find", [outsideDir], "read", [], projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toContain("find");
      expect(result.reason).toContain("read");
    }
  });
});

// ---------------------------------------------------------------------------
// Multiple paths
// ---------------------------------------------------------------------------

describe("multiple paths", () => {
  it("blocks when any path is outside project root", async () => {
    const inside = join(projectRoot, "file.txt");
    const outside = join(outsideDir, "secret.txt");
    await writeFile(inside, "");
    await writeFile(outside, "secret");

    const result = await guard("read", [inside, outside], "read", [], projectRoot);

    expect(result.allowed).toBe(false);
  });

  it("allows when all paths are within project root", async () => {
    const a = join(projectRoot, "a.txt");
    const b = join(projectRoot, "b.txt");
    await writeFile(a, "");
    await writeFile(b, "");

    const result = await guard("read", [a, b], "read", [], projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("blocks at the first denied path and returns its reason", async () => {
    const inside = join(projectRoot, "file.txt");
    const outside = join(outsideDir, "secret.txt");
    await writeFile(inside, "");
    await writeFile(outside, "secret");

    // outside comes first in the list
    const result = await guard("read", [outside, inside], "read", [], projectRoot);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Reason should reference the outside path
      expect(result.reason).toContain(outside);
    }
  });
});

// ---------------------------------------------------------------------------
// Home-anchored allow rule
// ---------------------------------------------------------------------------

describe("rule: home-anchored allow read within home", () => {
  it("allows read of file in homeDir subdir when a home-anchored allow rule permits it", async () => {
    // Build a home directory structure under the test temp dir
    const homeDir = join(tempDir, "home");
    const sshDir = join(homeDir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const keyFile = join(sshDir, "id_rsa");
    await writeFile(keyFile, "PRIVATE KEY");

    // Global-style rule: configDir = homeDir, homeDir = homeDir
    // The home-anchored pattern ~/ .ssh/ resolves to homeDir/.ssh/
    const rules: ParsedRule[] = [makeRule("~/.ssh/", "allow", homeDir, "read", homeDir)];

    const result = await guard("read", [keyFile], "read", rules, projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("does not allow read of file outside homeDir even with home-anchored allow rule", async () => {
    const homeDir = join(tempDir, "home");
    await mkdir(homeDir, { recursive: true });

    // outsideDir is outside homeDir
    const secretFile = join(outsideDir, "secret.txt");
    await writeFile(secretFile, "secret");

    const rules: ParsedRule[] = [makeRule("~/.ssh/", "allow", homeDir, "read", homeDir)];

    const result = await guard("read", [secretFile], "read", rules, projectRoot);

    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Absolute-anchored patterns (symlink resolution)
// ---------------------------------------------------------------------------

describe("rule: absolute-anchored allow read (with symlink resolution)", () => {
  it("allows read via symlink when rule uses the canonical real path", async () => {
    // Verifies the end-to-end flow: a rule built from the realpath'd canonical
    // form of a directory correctly allows access through a symlink to that dir
    // (since guard also resolves access paths via realpath).
    const targetDir = join(tempDir, "repos");
    await mkdir(targetDir, { recursive: true });
    const file = join(targetDir, "file.ts");
    await writeFile(file, "content");

    // Create a symlink pointing to the target
    const linkPath = join(tempDir, "repos-link");
    await symlink(targetDir, linkPath);

    // Rule uses the canonical (realpath'd) form of the target directory.
    // This simulates what resolveAbsolutePattern produces at config load time.
    const resolvedTarget = await realpath(targetDir);
    const rules: ParsedRule[] = [
      {
        pattern: parsePattern(`${resolvedTarget}/`),
        rawPattern: `${resolvedTarget}/`,
        operations: "read",
        effect: "allow",
        configDir: "/",
        homeDir: tempDir,
      },
    ];

    // Access via the symlink — guard resolves it to realpath, matching the rule.
    const fileViaLink = join(linkPath, "file.ts");
    const result = await guard("read", [fileViaLink], "read", rules, projectRoot);

    expect(result.allowed).toBe(true);
  });

  it("absolute-anchored pattern resolved at load time matches realpath'd access", async () => {
    // Simulate what loadConfig does: resolve the pattern's literal prefix.
    // Use tmpdir() which may be symlinked on macOS.
    const testSubdir = join(tmpdir(), `pi-ward-abs-test-${Date.now()}`);
    await mkdir(testSubdir, { recursive: true });
    const testFile = join(testSubdir, "data.json");
    await writeFile(testFile, "{}");

    try {
      // Resolve the real path (handles macOS /tmp → /private/tmp)
      const resolvedSubdir = await realpath(testSubdir);

      // Build a rule as loadConfig would: configDir="/", pattern resolved
      const rules: ParsedRule[] = [
        {
          pattern: parsePattern(`${resolvedSubdir}/`),
          rawPattern: `${resolvedSubdir}/`,
          operations: "read",
          effect: "allow",
          configDir: "/",
          homeDir: tempDir,
        },
      ];

      // Access via the original (potentially symlinked) path
      const result = await guard("read", [testFile], "read", rules, projectRoot);

      expect(result.allowed).toBe(true);
    } finally {
      await rm(testSubdir, { recursive: true, force: true });
    }
  });
});
