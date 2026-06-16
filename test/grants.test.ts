import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.js";
import { checkPath, guard } from "../src/guard.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";

let tempDir: string;
let projectRoot: string;
let outsideDir: string;

beforeEach(async () => {
  const base = join(tmpdir(), `pi-ward-grant-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(base, "project"), { recursive: true });
  await mkdir(join(base, "outside"), { recursive: true });
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
    rawPattern: pattern,
    operations: operations ?? "read",
    effect,
    configDir,
    homeDir: configDir,
  };
}

// ---------------------------------------------------------------------------
// GrantStore unit tests
// ---------------------------------------------------------------------------

describe("GrantStore", () => {
  it("isAllowed returns false when empty", () => {
    const store = new GrantStore();
    expect(store.isAllowed("/some/path", "read")).toBe(false);
  });

  it("session allow grants read access to exact path", () => {
    const store = new GrantStore();
    store.addAllow("/outside/file.txt", "read", false);
    expect(store.isAllowed("/outside/file.txt", "read")).toBe(true);
  });

  it("session allow for write grants both read and write", () => {
    const store = new GrantStore();
    store.addAllow("/outside/file.txt", "write", false);
    expect(store.isAllowed("/outside/file.txt", "read")).toBe(true);
    expect(store.isAllowed("/outside/file.txt", "write")).toBe(true);
  });

  it("session allow for read does not grant write", () => {
    const store = new GrantStore();
    store.addAllow("/outside/file.txt", "read", false);
    expect(store.isAllowed("/outside/file.txt", "write")).toBe(false);
  });

  it("directory allow covers descendants", () => {
    const store = new GrantStore();
    store.addAllow("/outside/dir", "read", true);
    expect(store.isAllowed("/outside/dir/file.txt", "read")).toBe(true);
    expect(store.isAllowed("/outside/dir/sub/deep.txt", "read")).toBe(true);
  });

  it("directory allow does not cover sibling paths", () => {
    const store = new GrantStore();
    store.addAllow("/outside/dir", "read", true);
    expect(store.isAllowed("/outside/other.txt", "read")).toBe(false);
  });

  it("file allow does not cover other files", () => {
    const store = new GrantStore();
    store.addAllow("/outside/file.txt", "read", false);
    expect(store.isAllowed("/outside/other.txt", "read")).toBe(false);
  });

  it("session deny blocks access", () => {
    const store = new GrantStore();
    store.addDeny("/outside/file.txt", "read", false);
    expect(store.isDenied("/outside/file.txt", "read")).toBe(true);
    expect(store.isDenied("/outside/file.txt", "write")).toBe(true);
  });

  it("session deny for write does not block read", () => {
    const store = new GrantStore();
    store.addDeny("/outside/file.txt", "write", false);
    expect(store.isDenied("/outside/file.txt", "read")).toBe(false);
    expect(store.isDenied("/outside/file.txt", "write")).toBe(true);
  });

  it("directory deny covers descendants", () => {
    const store = new GrantStore();
    store.addDeny("/outside/dir", "read", true);
    expect(store.isDenied("/outside/dir/file.txt", "read")).toBe(true);
  });

  it("clear removes all decisions", () => {
    const store = new GrantStore();
    store.addAllow("/a", "read", false);
    store.addDeny("/b", "read", false);
    store.clear();
    expect(store.isAllowed("/a", "read")).toBe(false);
    expect(store.isDenied("/b", "read")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GrantStore.revoke
// ---------------------------------------------------------------------------

describe("GrantStore.revoke", () => {
  it("removes an allow by exact path", () => {
    const store = new GrantStore();
    store.addAllow("/some/path", "read", false);
    const removed = store.revoke("/some/path");
    expect(removed).toBe(true);
    expect(store.isAllowed("/some/path", "read")).toBe(false);
  });

  it("removes a deny by exact path", () => {
    const store = new GrantStore();
    store.addDeny("/some/path", "read", false);
    const removed = store.revoke("/some/path");
    expect(removed).toBe(true);
    expect(store.isDenied("/some/path", "read")).toBe(false);
  });

  it("removes both allow and deny when both exist for the same path", () => {
    const store = new GrantStore();
    store.addAllow("/some/path", "read", false);
    store.addDeny("/some/path", "write", false);
    const removed = store.revoke("/some/path");
    expect(removed).toBe(true);
    expect(store.isAllowed("/some/path", "read")).toBe(false);
    expect(store.isDenied("/some/path", "write")).toBe(false);
  });

  it("returns false when path is not in store", () => {
    const store = new GrantStore();
    const removed = store.revoke("/not/present");
    expect(removed).toBe(false);
  });

  it("does not remove other paths", () => {
    const store = new GrantStore();
    store.addAllow("/keep/this", "read", false);
    store.revoke("/other/path");
    expect(store.isAllowed("/keep/this", "read")).toBe(true);
  });

  it("listAllows reflects removal", () => {
    const store = new GrantStore();
    store.addAllow("/a", "read", false);
    store.addAllow("/b", "write", false);
    store.revoke("/a");
    expect(store.listAllows()).toHaveLength(1);
    expect(store.listAllows()[0]?.path).toBe("/b");
  });
});

// ---------------------------------------------------------------------------
// checkPath with grants — integration
// ---------------------------------------------------------------------------

describe("checkPath with grants", () => {
  it("session allow overrides baseline deny", async () => {
    const file = join(outsideDir, "allowed.txt");
    await writeFile(file, "data");

    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addAllow(resolvedFile, "read", false);

    const result = await checkPath("read", file, "read", [], projectRoot, store);
    expect(result.allowed).toBe(true);
  });

  it("session deny suppresses future prompts", async () => {
    const file = join(outsideDir, "denied.txt");
    await writeFile(file, "secret");

    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addDeny(resolvedFile, "read", false);

    const result = await checkPath("read", file, "read", [], projectRoot, store);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.grantable).toBe(false);
      expect(result.reason).toMatch(/denied by user \(session\)/);
    }
  });

  it("grant cannot override explicit deny rule", async () => {
    const file = join(projectRoot, ".env.local");
    await writeFile(file, "SECRET=foo");

    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addAllow(resolvedFile, "read", false);

    const rules: ParsedRule[] = [makeRule(".env*", "deny", projectRoot)];
    const result = await checkPath("read", file, "read", rules, projectRoot, store);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.grantable).toBe(false);
      expect(result.reason).toMatch(/denied by policy/);
    }
  });

  it("baseline deny without grant is grantable", async () => {
    const file = join(outsideDir, "file.txt");
    await writeFile(file, "data");

    const result = await checkPath("read", file, "read", [], projectRoot);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.grantable).toBe(true);
    }
  });

  it("directory grant covers all files under it", async () => {
    const subDir = join(outsideDir, "sub");
    await mkdir(subDir, { recursive: true });
    const file = join(subDir, "deep.txt");
    await writeFile(file, "deep");

    const store = new GrantStore();
    const resolvedOutside = await realpath(outsideDir);
    store.addAllow(resolvedOutside, "write", true);

    const result = await checkPath("write", file, "write", [], projectRoot, store);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// guard (non-interactive) with grants
// ---------------------------------------------------------------------------

describe("guard with grants", () => {
  it("allows access when session grant matches", async () => {
    const file = join(outsideDir, "data.json");
    await writeFile(file, "{}");

    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addAllow(resolvedFile, "read", false);

    const result = await guard("read", [file], "read", [], projectRoot, store);
    expect(result.allowed).toBe(true);
  });

  it("denies access without grant for outside path", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");

    const result = await guard("read", [file], "read", [], projectRoot);
    expect(result.allowed).toBe(false);
  });
});
