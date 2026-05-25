import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guard } from "../src/guard.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";

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
): ParsedRule {
  return {
    pattern: parsePattern(pattern),
    operations: operations ?? "read",
    effect,
    configDir,
  };
}

// ---------------------------------------------------------------------------
// Baseline — no rules
// ---------------------------------------------------------------------------

describe("baseline — no rules", () => {
  it("allows read within project root", async () => {
    const file = join(projectRoot, "index.ts");
    await writeFile(file, "");

    const result = await guard("read", [file], "read", [], projectRoot, []);

    expect(result.allowed).toBe(true);
  });

  it("allows write within project root", async () => {
    const file = join(projectRoot, "output.txt");
    await writeFile(file, "");

    const result = await guard("write", [file], "write", [], projectRoot, []);

    expect(result.allowed).toBe(true);
  });

  it("denies read outside project root", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");

    const result = await guard("read", [file], "read", [], projectRoot, []);

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
  it("denies write to a ward config file", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    const result = await guard("write", [wardConfig], "write", [], projectRoot, [wardConfig]);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toMatch(/ward config/i);
    }
  });

  it("allows read of a ward config file (only writes are blocked)", async () => {
    const piDir = join(projectRoot, ".pi");
    const wardConfig = join(piDir, "ward.json");
    await mkdir(piDir, { recursive: true });
    await writeFile(wardConfig, '{"rules":[]}');

    const result = await guard("read", [wardConfig], "read", [], projectRoot, [wardConfig]);

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

    const result = await guard("read", [envFile], "read", rules, projectRoot, []);

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

    const result = await guard("write", [envFile], "write", rules, projectRoot, []);

    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule: allow read outside project (global-style config)
// ---------------------------------------------------------------------------

describe("rule: allow read outside project root", () => {
  it("allows read of file outside project when rule permits it", async () => {
    const file = join(outsideDir, "allowed.txt");
    await writeFile(file, "data");

    // configDir = tempDir (parent of both project and outside) — simulates a group-level config
    const rules: ParsedRule[] = [makeRule("./", "allow", tempDir, "read")];

    const result = await guard("read", [file], "read", rules, projectRoot, []);

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

    const result = await guard("read", [link], "read", [], projectRoot, []);

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

    const result = await guard("grep", [file], "read", [], projectRoot, []);

    expect(result.allowed).toBe(true);
  });

  it("guard with toolName 'grep' and operation 'read' blocks access outside project root", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");

    const result = await guard("grep", [file], "read", [], projectRoot, []);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\[pi-ward\]/);
      expect(result.reason).toContain("grep");
      expect(result.reason).toContain("read");
    }
  });

  it("guard with toolName 'find' and operation 'read' allows access within project root", async () => {
    const result = await guard("find", [projectRoot], "read", [], projectRoot, []);

    expect(result.allowed).toBe(true);
  });

  it("guard with toolName 'find' and operation 'read' blocks access outside project root", async () => {
    const result = await guard("find", [outsideDir], "read", [], projectRoot, []);

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

    const result = await guard("read", [inside, outside], "read", [], projectRoot, []);

    expect(result.allowed).toBe(false);
  });

  it("allows when all paths are within project root", async () => {
    const a = join(projectRoot, "a.txt");
    const b = join(projectRoot, "b.txt");
    await writeFile(a, "");
    await writeFile(b, "");

    const result = await guard("read", [a, b], "read", [], projectRoot, []);

    expect(result.allowed).toBe(true);
  });

  it("blocks at the first denied path and returns its reason", async () => {
    const inside = join(projectRoot, "file.txt");
    const outside = join(outsideDir, "secret.txt");
    await writeFile(inside, "");
    await writeFile(outside, "secret");

    // outside comes first in the list
    const result = await guard("read", [outside, inside], "read", [], projectRoot, []);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Reason should reference the outside path
      expect(result.reason).toContain(outside);
    }
  });
});
