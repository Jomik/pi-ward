import { join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { GrantStore } from "../src/grants.js";
import { extractAccess, promptAccess } from "../src/index.js";

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
  // delete
  // -------------------------------------------------------------------------

  it("maps 'delete' to operation='write' with the provided path", () => {
    const path = join(projectRoot, "old-file.txt");
    const result = extractAccess(makeEvent("delete", { path }), projectRoot);
    expect(result).toEqual({ operation: "write", paths: [path] });
  });

  // -------------------------------------------------------------------------
  // move
  // -------------------------------------------------------------------------

  it("maps 'move' to operation='write' with source and destination paths", () => {
    const source = join(projectRoot, "old-name.txt");
    const destination = join(projectRoot, "new-name.txt");
    const result = extractAccess(makeEvent("move", { source, destination }), projectRoot);
    expect(result).toEqual({ operation: "write", paths: [source, destination] });
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

describe("promptAccess herdr reporting", () => {
  const path = "/outside/file.txt";

  it("reports blocked across both approval prompts", async () => {
    const trace: string[] = [];
    const events = {
      emit: vi.fn((channel: string, data: unknown) => {
        trace.push(`${channel}:${String((data as { active: boolean }).active)}`);
      }),
    };
    const ctx = {
      hasUI: true,
      ui: {
        select: vi.fn(async (message: string) => {
          trace.push(`select:${message}`);
          return message.startsWith("Access") ? "Approve" : "Once";
        }),
      },
    };

    await promptAccess(events, ctx, "read", "read", path, path, new GrantStore());

    expect(trace).toEqual([
      "herdr:blocked:true",
      `select:Access outside project root:\n\n  read ${path}`,
      "select:Approve scope:",
      "herdr:blocked:false",
    ]);
    expect(events.emit).toHaveBeenNthCalledWith(1, "herdr:blocked", {
      active: true,
      label: `Ward approval: read ${path}`,
    });
    expect(events.emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
  });

  it("clears blocked state when the approval UI throws", async () => {
    const events = { emit: vi.fn() };
    const ctx = {
      hasUI: true,
      ui: { select: vi.fn().mockRejectedValue(new Error("UI crashed")) },
    };

    await expect(promptAccess(events, ctx, "write", "write", path, path, new GrantStore())).rejects.toThrow(
      "UI crashed",
    );

    expect(events.emit).toHaveBeenLastCalledWith("herdr:blocked", { active: false });
  });

  it("does not report blocked without UI", async () => {
    const events = { emit: vi.fn() };
    const ctx = { hasUI: false, ui: { select: vi.fn() } };

    await promptAccess(events, ctx, "read", "read", path, path, new GrantStore());

    expect(events.emit).not.toHaveBeenCalled();
  });
});
