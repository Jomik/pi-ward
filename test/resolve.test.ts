import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guard } from "../src/guard.js";
import { resolvePath, resolveRealPath } from "../src/resolve.js";

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
  it("resolves to ancestor + remaining segments when intermediate dirs don't exist", async () => {
    const newFile = join(projectRoot, "ghost-dir", "file.txt");

    const result = await resolvePath(newFile, projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(newFile);
  });

  it("resolves deeply nested non-existent paths", async () => {
    const newFile = join(projectRoot, "a", "b", "c", "file.txt");

    const result = await resolvePath(newFile, projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(newFile);
  });

  it("resolves through symlinked ancestor to reveal real path", async () => {
    // outside/ is a real dir; project/link -> outside
    const outsideDir = join(tempDir, "outside");
    await mkdir(outsideDir);
    const linkInProject = join(projectRoot, "link");
    await symlink(outsideDir, linkInProject);

    // Write to link/new-dir/file.txt — "new-dir" doesn't exist,
    // but "link" does and is a symlink. Should resolve through it.
    const newFile = join(projectRoot, "link", "new-dir", "file.txt");
    const result = await resolvePath(newFile, projectRoot);

    expect(result.denied).toBeUndefined();
    // The resolved path should go through the symlink target, not the link itself.
    expect(result.path).toBe(join(outsideDir, "new-dir", "file.txt"));
  });
});

describe("dot-dot normalization", () => {
  it("normalizes .. in absolute paths before walk-up", async () => {
    // An absolute path with .. that would escape the project if not normalized
    const malicious = `${projectRoot}/ghost/../../outside/file.txt`;

    const result = await resolvePath(malicious, projectRoot);

    // resolve() normalizes .. away, so the resolved path stays correct
    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(join(tempDir, "outside", "file.txt"));
  });

  it("normalizes .. in relative paths before walk-up", async () => {
    const result = await resolvePath("ghost/../other/file.txt", projectRoot);

    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(join(projectRoot, "other", "file.txt"));
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

// ---------------------------------------------------------------------------
// resolveRealPath
// ---------------------------------------------------------------------------

describe("resolveRealPath", () => {
  it("resolves an existing path to its real path", async () => {
    const file = join(projectRoot, "exists.txt");
    await writeFile(file, "hello");

    const result = await resolveRealPath(file);
    expect(result).toBe(file);
  });

  it("resolves a symlink to its real target", async () => {
    const target = join(projectRoot, "target.txt");
    await writeFile(target, "content");
    const link = join(projectRoot, "link.txt");
    await symlink(target, link);

    const result = await resolveRealPath(link);
    expect(result).toBe(target);
  });

  it("walks up to find existing ancestor for non-existent path", async () => {
    const nonExistent = join(projectRoot, "no-such-dir", "file.txt");

    const result = await resolveRealPath(nonExistent);
    expect(result).toBe(resolve(projectRoot, "no-such-dir", "file.txt"));
  });

  it("returns null when no existing ancestor can be found", async () => {
    // This is essentially unreachable on real systems (root always exists)
    // but we test the contract — if somehow nothing resolves, returns null.
    // We can't easily test this without mocking, so skip.
  });

  it("throws on EACCES (non-ENOENT error)", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return; // skip when running as root
    }

    const restrictedDir = join(projectRoot, "no-access");
    const file = join(restrictedDir, "secret.txt");
    await mkdir(restrictedDir);
    await writeFile(file, "secret");
    await chmod(restrictedDir, 0o000);

    try {
      await expect(resolveRealPath(file)).rejects.toThrow();
    } finally {
      await chmod(restrictedDir, 0o755);
    }
  });

  it("resolves symlinked ancestor in non-existent path", async () => {
    // Create: realDir/ and symlink linkDir -> realDir
    const realDir = join(projectRoot, "real");
    await mkdir(realDir);
    const linkDir = join(projectRoot, "link");
    await symlink(realDir, linkDir);

    // Ask to resolve linkDir/non-existent.txt
    const result = await resolveRealPath(join(linkDir, "non-existent.txt"));
    // Should resolve through the symlink
    expect(result).toBe(resolve(realDir, "non-existent.txt"));
  });
});

// ---------------------------------------------------------------------------
// tilde expansion
// ---------------------------------------------------------------------------

describe("tilde expansion", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = join(tempDir, "home");
    await mkdir(fakeHome);
  });

  // --- Regression: minimal failing test (shows bypass before fix) ---

  it("guard baseline-deny regression: '~/' path is denied outside project root", async () => {
    // Before fix: resolvePath('~/sensitive', projectRoot) → projectRoot + '/~/sensitive'
    // That is UNDER projectRoot → baseline-allow → security bypass.
    // After fix: expands to homedir()/sensitive → outside projectRoot → baseline-deny.
    const result = await guard("read", ["~/sensitive"], "read", [], projectRoot);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/outside project root/i);
    }
  });

  // --- Focused expansion tests (use homeDir parameter for determinism) ---

  it("expands bare '~' to homeDir", async () => {
    const result = await resolvePath("~", projectRoot, fakeHome);
    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(fakeHome);
  });

  it("expands '~/.ssh' to homeDir/.ssh (non-existent child, resolves via ancestor)", async () => {
    // fakeHome exists, .ssh does not — walks up to fakeHome then re-appends .ssh
    const result = await resolvePath("~/.ssh", projectRoot, fakeHome);
    expect(result.denied).toBeUndefined();
    expect(result.path).toBe(join(fakeHome, ".ssh"));
  });

  it("leaves '~user' unchanged — treated as project-relative path", async () => {
    // '~user' is not a tilde expansion — must not be confused with ~/ or ~
    const result = await resolvePath("~user", projectRoot, fakeHome);
    expect(result.denied).toBeUndefined();
    // Resolves as projectRoot/~user (relative, not home-relative)
    expect(result.path).toBe(join(projectRoot, "~user"));
  });
});
