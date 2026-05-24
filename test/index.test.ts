import { join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { extractAccess } from "../src/index.js";

const projectRoot = "/project";

/**
 * Build a minimal ToolCallEvent for a standard tool.
 */
function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "test-id", toolName, input } as ToolCallEvent;
}

describe("extractAccess", () => {
  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  it("maps 'read' to operation='read' with the provided path", () => {
    const path = join(projectRoot, "src", "index.ts");
    const result = extractAccess(makeEvent("read", { path }), projectRoot);
    expect(result).toEqual({ operation: "read", paths: [path] });
  });

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  it("maps 'write' to operation='write' with the provided path", () => {
    const path = join(projectRoot, "output.txt");
    const result = extractAccess(makeEvent("write", { path }), projectRoot);
    expect(result).toEqual({ operation: "write", paths: [path] });
  });

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------

  it("maps 'edit' to operation='write' with the provided path", () => {
    const path = join(projectRoot, "src", "app.ts");
    const result = extractAccess(makeEvent("edit", { path, edits: [] }), projectRoot);
    expect(result).toEqual({ operation: "write", paths: [path] });
  });

  // -------------------------------------------------------------------------
  // grep
  // -------------------------------------------------------------------------

  it("maps 'grep' with path to operation='read' with that path", () => {
    const path = join(projectRoot, "src");
    const result = extractAccess(makeEvent("grep", { pattern: "foo", path }), projectRoot);
    expect(result).toEqual({ operation: "read", paths: [path] });
  });

  it("maps 'grep' without path to operation='read' defaulting to projectRoot", () => {
    const result = extractAccess(makeEvent("grep", { pattern: "foo" }), projectRoot);
    expect(result).toEqual({ operation: "read", paths: [projectRoot] });
  });

  // -------------------------------------------------------------------------
  // find
  // -------------------------------------------------------------------------

  it("maps 'find' with path to operation='read' with that path", () => {
    const path = join(projectRoot, "src");
    const result = extractAccess(makeEvent("find", { pattern: "*.ts", path }), projectRoot);
    expect(result).toEqual({ operation: "read", paths: [path] });
  });

  it("maps 'find' without path to operation='read' defaulting to projectRoot", () => {
    const result = extractAccess(makeEvent("find", { pattern: "*.ts" }), projectRoot);
    expect(result).toEqual({ operation: "read", paths: [projectRoot] });
  });

  // -------------------------------------------------------------------------
  // ls
  // -------------------------------------------------------------------------

  it("maps 'ls' with path to operation='read' with that path", () => {
    const path = join(projectRoot, "src");
    const result = extractAccess(makeEvent("ls", { path }), projectRoot);
    expect(result).toEqual({ operation: "read", paths: [path] });
  });

  it("maps 'ls' without path to operation='read' defaulting to projectRoot", () => {
    const result = extractAccess(makeEvent("ls", {}), projectRoot);
    expect(result).toEqual({ operation: "read", paths: [projectRoot] });
  });

  // -------------------------------------------------------------------------
  // ignored tools
  // -------------------------------------------------------------------------

  it("returns null for 'bash' (not intercepted)", () => {
    const result = extractAccess(makeEvent("bash", { command: "ls" }), projectRoot);
    expect(result).toBeNull();
  });

  it("returns null for unknown custom tools", () => {
    const result = extractAccess(makeEvent("my_custom_tool", { foo: "bar" }), projectRoot);
    expect(result).toBeNull();
  });
});
