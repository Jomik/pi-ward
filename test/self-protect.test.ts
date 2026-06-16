import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before imports that use getAgentDir so vitest can hoist it.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSelfProtected } from "../src/self-protect.js";

const mockGetAgentDir = vi.mocked(getAgentDir);

const testHome = "/mock/home";
const testProject = join(testHome, "projects", "myproject");

beforeEach(() => {
  mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isSelfProtected — structural predicate (.pi/ward.json)
// ---------------------------------------------------------------------------

describe("isSelfProtected — .pi/ward.json predicate", () => {
  it("returns true for the project config path", () => {
    expect(isSelfProtected(join(testProject, ".pi", "ward.json"))).toBe(true);
  });

  it("returns true for a .pi/ward.json path anywhere in the tree", () => {
    expect(isSelfProtected("/some/other/.pi/ward.json")).toBe(true);
  });

  it("returns true for a .pi/ward.json path at the filesystem root level", () => {
    expect(isSelfProtected("/.pi/ward.json")).toBe(true);
  });

  it("returns true for .pi/ward.json inside home directory", () => {
    expect(isSelfProtected(join(testHome, ".pi", "ward.json"))).toBe(true);
  });

  it("returns true for .pi/ward.json in any ancestor directory", () => {
    expect(isSelfProtected(join(testHome, "projects", ".pi", "ward.json"))).toBe(true);
  });

  it("returns false for a non-ward.json filename in .pi/", () => {
    expect(isSelfProtected(join(testProject, ".pi", "other.json"))).toBe(false);
  });

  it("returns false for ward.json not in a .pi/ directory", () => {
    expect(isSelfProtected(join(testProject, "ward.json"))).toBe(false);
  });

  it("returns false for a regular source file", () => {
    expect(isSelfProtected(join(testProject, "src", "index.ts"))).toBe(false);
  });

  it("returns false for a .pi/ directory itself (no ward.json)", () => {
    expect(isSelfProtected(join(testProject, ".pi"))).toBe(false);
  });

  it("returns false for ward.json nested deeper under .pi/", () => {
    // .pi/agent/ward.json — parent is 'agent', not '.pi', so predicate is false
    // (global config is handled by the separate explicit check)
    expect(isSelfProtected(join(testProject, ".pi", "agent", "ward.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — global config explicit check
// ---------------------------------------------------------------------------

describe("isSelfProtected — global config path", () => {
  it("returns true for the global config path (~/.pi/agent/ward.json)", () => {
    expect(isSelfProtected(join(testHome, ".pi", "agent", "ward.json"))).toBe(true);
  });

  it("returns false for a different ward.json under .pi/agent/", () => {
    // If getAgentDir points elsewhere, a different path is not the global config
    mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
    expect(isSelfProtected(join("/other", ".pi", "agent", "ward.json"))).toBe(false);
  });

  it("uses whatever path getAgentDir returns", () => {
    mockGetAgentDir.mockReturnValue("/custom/agent/dir");
    expect(isSelfProtected("/custom/agent/dir/ward.json")).toBe(true);
    expect(isSelfProtected(join(testHome, ".pi", "agent", "ward.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — nonexistent path creation is blocked
// ---------------------------------------------------------------------------

describe("isSelfProtected — creation of nonexistent .pi/ward.json", () => {
  it("returns true for a nonexistent .pi/ward.json path (structural check applies)", () => {
    // Even if the file doesn't exist, the resolved path still ends with .pi/ward.json
    // (resolvePath walks up to the nearest existing ancestor and re-appends the suffix)
    expect(isSelfProtected("/nonexistent/dir/.pi/ward.json")).toBe(true);
  });

  it("returns false for a nonexistent path that does not match the pattern", () => {
    expect(isSelfProtected("/nonexistent/dir/ward.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelfProtected — similar-looking paths that should NOT be protected
// ---------------------------------------------------------------------------

describe("isSelfProtected — similar paths that are not protected", () => {
  it("returns false for ward.json in a directory named pi (without dot)", () => {
    expect(isSelfProtected(join(testProject, "pi", "ward.json"))).toBe(false);
  });

  it("returns false for ward.json in a directory named .pi-backup", () => {
    expect(isSelfProtected(join(testProject, ".pi-backup", "ward.json"))).toBe(false);
  });

  it("returns false for ward.json in a directory named pi. (trailing dot)", () => {
    expect(isSelfProtected(join(testProject, "pi.", "ward.json"))).toBe(false);
  });

  it("returns false for .ward.json in a .pi/ directory", () => {
    expect(isSelfProtected(join(testProject, ".pi", ".ward.json"))).toBe(false);
  });

  it("returns false for ward.json.bak in a .pi/ directory", () => {
    expect(isSelfProtected(join(testProject, ".pi", "ward.json.bak"))).toBe(false);
  });
});
