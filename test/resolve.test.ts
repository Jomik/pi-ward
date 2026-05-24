import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePath } from "../src/resolve.js";

let tempDir: string;
let projectRoot: string;

beforeEach(async () => {
  // Use realpath so that macOS /var/folders (symlinked via /tmp) is resolved to /private/var.
  const base = join(tmpdir(), `pi-ward-resolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(base, "project"), { recursive: true });
  tempDir = await realpath(base);
  projectRoot = join(tempDir, "project");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("normal absolute path", () => {
  it("returns the real path for an existing file", async () => {
    const filePath = join(projectRoot, "file.txt");
    await writeFile(filePath, "content");

    const result = await resolvePath(filePath, projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(filePath);
  });
});

describe("relative path", () => {
  it("resolves relative path against projectRoot", async () => {
    const filePath = join(projectRoot, "file.txt");
    await writeFile(filePath, "content");

    const result = await resolvePath("file.txt", projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(filePath);
  });

  it("resolves nested relative path against projectRoot", async () => {
    const dir = join(projectRoot, "src");
    await mkdir(dir);
    const filePath = join(dir, "index.ts");
    await writeFile(filePath, "");

    const result = await resolvePath("src/index.ts", projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(resolve(projectRoot, "src/index.ts"));
  });
});

describe("symlink", () => {
  it("resolves symlink to the real path of its target", async () => {
    const realFile = join(projectRoot, "real.txt");
    const linkFile = join(projectRoot, "link.txt");
    await writeFile(realFile, "content");
    await symlink(realFile, linkFile);

    const result = await resolvePath(linkFile, projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(realFile);
  });
});

describe("broken symlink (dangling)", () => {
  it("returns denied for a symlink pointing to a nonexistent target", async () => {
    const linkFile = join(projectRoot, "broken-link.txt");
    await symlink(join(projectRoot, "nonexistent.txt"), linkFile);

    const result = await resolvePath(linkFile, projectRoot);

    expect(result.denied).toBeDefined();
    expect(result.denied).toMatch(/broken symlink/i);
  });
});

describe("non-existent file (new file case)", () => {
  it("resolves to parent + filename when file doesn't exist but parent does", async () => {
    const newFile = join(projectRoot, "new-file.txt");
    // projectRoot exists; new-file.txt does not

    const result = await resolvePath(newFile, projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(newFile);
  });
});

describe("non-existent parent directory", () => {
  it("returns denied when the parent directory doesn't exist", async () => {
    const newFile = join(projectRoot, "ghost-dir", "file.txt");

    const result = await resolvePath(newFile, projectRoot);

    expect(result.denied).toBeDefined();
  });
});

describe("permission error", () => {
  it("returns denied when realpath fails with EACCES", async () => {
    // Skip when running as root (root bypasses permissions).
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }

    const restrictedDir = join(projectRoot, "restricted");
    const file = join(restrictedDir, "file.txt");
    await mkdir(restrictedDir);
    await writeFile(file, "content");
    await chmod(restrictedDir, 0o000);

    try {
      const result = await resolvePath(file, projectRoot);
      expect(result.denied).toBeDefined();
    } finally {
      await chmod(restrictedDir, 0o755);
    }
  });
});
