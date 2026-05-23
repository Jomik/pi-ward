import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before imports that use homedir so vitest can hoist it.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

import { homedir } from "node:os";
import { join } from "node:path";
import { getProtectedPaths, isSelfProtected } from "../src/self-protect.js";

const mockHomedir = vi.mocked(homedir);

const testHome = "/mock/home";
const testProject = join(testHome, "projects", "myproject");

beforeEach(() => {
  mockHomedir.mockReturnValue(testHome);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getProtectedPaths
// ---------------------------------------------------------------------------

describe("getProtectedPaths", () => {
  it("includes the global config path", () => {
    const paths = getProtectedPaths(testProject);
    expect(paths).toContain(join(testHome, ".pi", "agent", "ward.json"));
  });

  it("includes the project config path", () => {
    const paths = getProtectedPaths(testProject);
    expect(paths).toContain(join(testProject, ".pi", "ward.json"));
  });

  it("includes ancestor config paths between homedir and projectRoot", () => {
    const paths = getProtectedPaths(testProject);
    // home-level ancestor: ~/.pi/ward.json
    expect(paths).toContain(join(testHome, ".pi", "ward.json"));
    // intermediate ancestor: ~/projects/.pi/ward.json
    expect(paths).toContain(join(testHome, "projects", ".pi", "ward.json"));
  });

  it("returns all paths in order: global, home-level, intermediate, project", () => {
    const paths = getProtectedPaths(testProject);
    expect(paths).toEqual([
      join(testHome, ".pi", "agent", "ward.json"),
      join(testHome, ".pi", "ward.json"),
      join(testHome, "projects", ".pi", "ward.json"),
      join(testProject, ".pi", "ward.json"),
    ]);
  });

  it("only includes global config when projectRoot is outside homedir", () => {
    const outsideProject = "/other/project";
    const paths = getProtectedPaths(outsideProject);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(join(testHome, ".pi", "agent", "ward.json"));
  });

  it("handles projectRoot equal to homedir", () => {
    const paths = getProtectedPaths(testHome);
    expect(paths).toContain(join(testHome, ".pi", "agent", "ward.json"));
    expect(paths).toContain(join(testHome, ".pi", "ward.json"));
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected
// ---------------------------------------------------------------------------

describe("isSelfProtected", () => {
  it("returns true for the global config path", () => {
    const protectedPaths = getProtectedPaths(testProject);
    expect(isSelfProtected(join(testHome, ".pi", "agent", "ward.json"), protectedPaths)).toBe(true);
  });

  it("returns true for the project config path", () => {
    const protectedPaths = getProtectedPaths(testProject);
    expect(isSelfProtected(join(testProject, ".pi", "ward.json"), protectedPaths)).toBe(true);
  });

  it("returns true for the home-level ancestor config path", () => {
    const protectedPaths = getProtectedPaths(testProject);
    expect(isSelfProtected(join(testHome, ".pi", "ward.json"), protectedPaths)).toBe(true);
  });

  it("returns true for an intermediate ancestor config path", () => {
    const protectedPaths = getProtectedPaths(testProject);
    expect(isSelfProtected(join(testHome, "projects", ".pi", "ward.json"), protectedPaths)).toBe(true);
  });

  it("returns false for a non-config path in the project", () => {
    const protectedPaths = getProtectedPaths(testProject);
    expect(isSelfProtected(join(testProject, "src", "index.ts"), protectedPaths)).toBe(false);
  });

  it("returns false for a ward.json outside the ancestor chain", () => {
    const protectedPaths = getProtectedPaths(testProject);
    expect(isSelfProtected("/some/other/.pi/ward.json", protectedPaths)).toBe(false);
  });

  it("returns false for a path that looks similar but is not exact", () => {
    const protectedPaths = getProtectedPaths(testProject);
    // Note: no ".pi" directory in this path
    expect(isSelfProtected(join(testProject, "ward.json"), protectedPaths)).toBe(false);
  });
});
