import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantStore } from "../src/grants.js";
import { createPromptTracker, extractAccess, handleToolCall, promptAccess } from "../src/index.js";

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

describe("createPromptTracker", () => {
  it("retains prompt text for an 'interactive' source", () => {
    const tracker = createPromptTracker();
    tracker.recordInput({ source: "interactive", text: "read @foo.txt" });
    expect(tracker.getLatest()).toBe("read @foo.txt");
  });

  it("retains prompt text for an 'rpc' source", () => {
    const tracker = createPromptTracker();
    tracker.recordInput({ source: "rpc", text: "read @foo.txt" });
    expect(tracker.getLatest()).toBe("read @foo.txt");
  });

  it("does not retain prompt text for an 'extension' source", () => {
    const tracker = createPromptTracker();
    tracker.recordInput({ source: "extension", text: "read @foo.txt" });
    expect(tracker.getLatest()).toBeUndefined();
  });

  it("does not let an 'extension'-sourced input replace the latest genuine prompt", () => {
    const tracker = createPromptTracker();
    tracker.recordInput({ source: "interactive", text: "genuine prompt" });
    tracker.recordInput({ source: "extension", text: "injected prompt" });
    expect(tracker.getLatest()).toBe("genuine prompt");
  });
});

describe("handleToolCall", () => {
  let tempDir: string;
  let testProjectRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    const base = join(tmpdir(), `pi-ward-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(base, "project"), { recursive: true });
    await mkdir(join(base, "outside"), { recursive: true });
    tempDir = await realpath(base);
    testProjectRoot = join(tempDir, "project");
    outsideDir = join(tempDir, "outside");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeReadEvent(path: string): ToolCallEvent {
    return { type: "tool_call", toolCallId: "test-id", toolName: "read", input: { path } } as ToolCallEvent;
  }

  function makeWriteEvent(path: string): ToolCallEvent {
    return {
      type: "tool_call",
      toolCallId: "test-id",
      toolName: "write",
      input: { path, content: "x" },
    } as ToolCallEvent;
  }

  function makeCtx(select?: (msg: string) => Promise<string | undefined>) {
    return {
      hasUI: select !== undefined,
      ui: { select: vi.fn(select ?? (async () => undefined)) },
    };
  }

  const events = { emit: vi.fn() };

  it("silently approves a grantable read matching the latest interactive prompt, without a UI prompt or grant", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = makeCtx(); // hasUI: false — would otherwise hard-block

    const result = await handleToolCall(makeReadEvent(file), ctx, events, {
      rules: [],
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: `read @${file}`,
    });

    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(grants.isAllowed(file, "read")).toBe(false);
  });

  it("works when ctx.hasUI is false — approval does not require UI", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = { hasUI: false, ui: { select: vi.fn() } };

    const result = await handleToolCall(makeReadEvent(file), ctx, events, {
      rules: [],
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: `read @${file}`,
    });

    expect(result).toBeUndefined();
  });

  it("allows repeated matching reads during the same current prompt", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = { hasUI: false, ui: { select: vi.fn() } };
    const deps = {
      rules: [],
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: `read @${file}`,
    };

    const first = await handleToolCall(makeReadEvent(file), ctx, events, deps);
    const second = await handleToolCall(makeReadEvent(file), ctx, events, deps);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
  });

  it("falls through to UI prompting when the prompt does not reference the target", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = makeCtx(async (msg) => (msg.startsWith("Access") ? "Approve" : "Once"));

    const result = await handleToolCall(makeReadEvent(file), ctx, events, {
      rules: [],
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: "unrelated prompt text",
    });

    expect(result).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalled();
  });

  it("does not consult the prompt for a no-prompt state (falls through to UI prompting)", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = { hasUI: false, ui: { select: vi.fn() } };

    const result = await handleToolCall(makeReadEvent(file), ctx, events, {
      rules: [],
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: undefined,
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("outside project root"),
    });
  });

  it("does not consult the prompt for write operations (unchanged behavior)", async () => {
    const file = join(outsideDir, "output.txt");
    const grants = new GrantStore();
    const ctx = { hasUI: false, ui: { select: vi.fn() } };

    const result = await handleToolCall(makeWriteEvent(file), ctx, events, {
      rules: [],
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: `write @${file}`,
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("outside project root"),
    });
  });

  it("does not consult the prompt for an explicit deny rule (hard deny, unchanged behavior)", async () => {
    const { parsePattern } = await import("../src/pattern.js");
    const file = join(testProjectRoot, ".env.local");
    await writeFile(file, "SECRET=foo");
    const rules = [
      {
        pattern: parsePattern(".env*"),
        rawPattern: ".env*",
        operations: "read" as const,
        effect: "deny" as const,
        configDir: testProjectRoot,
        homeDir: tempDir,
      },
    ];
    const grants = new GrantStore();
    const ctx = { hasUI: false, ui: { select: vi.fn() } };

    const result = await handleToolCall(makeReadEvent(file), ctx, events, {
      rules,
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: `read @${file}`,
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("denied by policy"),
    });
  });

  it("does not consult the prompt for a session deny (unchanged behavior)", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const resolved = await realpath(file);
    grants.addDeny(resolved, "read", false);
    const ctx = { hasUI: false, ui: { select: vi.fn() } };

    const result = await handleToolCall(makeReadEvent(file), ctx, events, {
      rules: [],
      projectRoot: testProjectRoot,
      homeDir: tempDir,
      grants,
      latestPrompt: `read @${file}`,
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("denied by user (session)"),
    });
  });
});
