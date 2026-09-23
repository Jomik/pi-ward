import { chmod, mkdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantStore } from "../src/grants.js";
import factory, {
  describeToolCall,
  extractAccess,
  getArgumentCompletions,
  handleGrepResult,
  handleToolCall,
  promptAccess,
  reloadWardPolicy,
} from "../src/index.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: vi.fn() };
});

const mockGetAgentDir = vi.mocked(getAgentDir);

beforeEach(() => {
  // Default stub so unrelated tests (self-protection checks inside
  // handleToolCall etc.) don't crash on an unconfigured getAgentDir().
  // Tests exercising reloadWardPolicy override this with a real temp path.
  mockGetAgentDir.mockReturnValue("/pi-ward-test-unused-agent-dir");
});

const projectRoot = "/project";

/** Build a minimal ToolCallEvent. */
function makeEvent(toolName: string, input: Record<string, unknown>, toolCallId = "test-id"): ToolCallEvent {
  return { type: "tool_call", toolCallId, toolName, input } as ToolCallEvent;
}

const makeReadEvent = (path: string) => makeEvent("read", { path });
const makeWriteEvent = (path: string) => makeEvent("write", { path, content: "x" });
const makeGrepEvent = (path: string, toolCallId = "test-id") => makeEvent("grep", { pattern: "foo", path }, toolCallId);

/** A `ctx` with no UI (default) or a UI whose `select` follows the given script. */
function makeCtx(select?: (msg: string) => Promise<string | undefined>) {
  return {
    hasUI: select !== undefined,
    ui: { select: vi.fn(select ?? (async () => undefined)) },
  };
}

/** Create the temp `<prefix>/project` and `<prefix>/outside` dirs used across guard tests. */
async function makeTestDirs(prefix: string) {
  const base = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(base, "project"), { recursive: true });
  await mkdir(join(base, "outside"), { recursive: true });
  const tempDir = await realpath(base);
  return { tempDir, testProjectRoot: join(tempDir, "project"), outsideDir: join(tempDir, "outside") };
}

/** Build a `handleToolCall` deps object, filling in the common projectRoot/homeDir pairing. */
function baseDeps(testProjectRoot: string, tempDir: string, grants: GrantStore, extra: Record<string, unknown> = {}) {
  return { rules: [], projectRoot: testProjectRoot, homeDir: tempDir, grants, latestPrompt: undefined, ...extra };
}

/** Build a `handleGrepResult` deps object. */
function grepResultDeps(
  testProjectRoot: string,
  grants: GrantStore,
  callContexts: Map<string, string>,
  rules: ParsedRule[] = [],
) {
  return { rules, projectRoot: testProjectRoot, grants, callContexts };
}

/** A single-pattern deny rule, as produced by config loading. */
function denyRule(pattern: string, configDir: string, homeDir: string) {
  return {
    pattern: parsePattern(pattern),
    rawPattern: pattern,
    operations: "read" as const,
    effect: "deny" as const,
    configDir,
    homeDir,
  };
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

describe("describeToolCall", () => {
  it("includes the pattern and search path for 'find'", () => {
    const event = makeEvent("find", { pattern: "**/project.assets.json", path: "~/orca" });
    const summary = describeToolCall(event, "read", "~/orca");
    expect(summary).toBe("find **/project.assets.json in ~/orca");
  });

  it("includes the pattern and search path for 'grep'", () => {
    const event = makeEvent("grep", { pattern: "TODO", path: "/outside/src" });
    const summary = describeToolCall(event, "read", "/outside/src");
    expect(summary).toBe("grep TODO in /outside/src");
  });

  it("falls back to '<operation> <path>' for other guarded tools", () => {
    const path = "/outside/file.txt";
    expect(describeToolCall(makeReadEvent(path), "read", path)).toBe(`read ${path}`);
    expect(describeToolCall(makeWriteEvent(path), "write", path)).toBe(`write ${path}`);
  });

  it("names the path for 'edit'", () => {
    const path = "/outside/app.ts";
    const event = makeEvent("edit", { path, edits: [] });
    expect(describeToolCall(event, "write", path)).toBe(`edit ${path}`);
  });

  it("names the path for 'ls'", () => {
    const path = "/outside/dir";
    const event = makeEvent("ls", { path });
    expect(describeToolCall(event, "read", path)).toBe(`ls ${path}`);
  });

  it("names the path for 'delete'", () => {
    const path = "/outside/file.txt";
    const event = makeEvent("delete", { path });
    expect(describeToolCall(event, "write", path)).toBe(`delete ${path}`);
  });

  it("names both source and destination for 'move', regardless of which path triggered the prompt", () => {
    const source = "/outside/old-name.txt";
    const destination = "/outside/new-name.txt";
    const event = makeEvent("move", { source, destination });
    expect(describeToolCall(event, "write", source)).toBe(`move ${source} to ${destination}`);
    expect(describeToolCall(event, "write", destination)).toBe(`move ${source} to ${destination}`);
  });
});

describe("getArgumentCompletions", () => {
  it("offers read/write after 'allow '", () => {
    const result = getArgumentCompletions("allow ");
    expect(result?.map((i) => i.label)).toEqual(["read", "write"]);
  });

  it("offers read/write after 'deny '", () => {
    const result = getArgumentCompletions("deny ");
    expect(result?.map((i) => i.label)).toEqual(["read", "write"]);
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

  it("shows the provided summary (not generic '<operation> <path>') in the prompt and herdr label", async () => {
    const events = { emit: vi.fn() };
    const ctx = {
      hasUI: true,
      ui: {
        select: vi.fn(async (message: string) => (message.startsWith("Access") ? "Approve" : "Once")),
      },
    };
    const summary = "find **/project.assets.json in ~/orca";

    await promptAccess(events, ctx, "find", "read", "~/orca", "/home/user/orca", new GrantStore(), summary);

    expect(events.emit).toHaveBeenNthCalledWith(1, "herdr:blocked", {
      active: true,
      label: `Ward approval: ${summary}`,
    });
    expect(ctx.ui.select).toHaveBeenNthCalledWith(1, `Access outside project root:\n\n  ${summary}`, [
      "Deny",
      "Approve",
    ]);
  });

  let scopeTempDir: string;

  afterEach(async () => {
    if (scopeTempDir) await rm(scopeTempDir, { recursive: true, force: true });
  });

  async function makeScopeDirs() {
    const base = join(tmpdir(), `pi-ward-prompt-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(base, { recursive: true });
    scopeTempDir = base;
    return base;
  }

  it("offers directory-only scope options and grants recursively for a directory target", async () => {
    const dir = await makeScopeDirs();
    const events = { emit: vi.fn() };
    const grants = new GrantStore();
    let capturedOptions: string[] | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        select: vi.fn(async (message: string, options?: string[]) => {
          if (message.startsWith("Approve scope")) capturedOptions = options;
          return message.startsWith("Access") ? "Approve" : `Allow ${dir} for session`;
        }),
      },
    };

    await promptAccess(events, ctx, "read", "read", dir, dir, grants);

    expect(capturedOptions).toEqual(["Once", `Allow ${dir} for session`]);
    expect(grants.listAllows()).toEqual([{ path: dir, operation: "read", directory: true }]);

    const nested = join(dir, "child.txt");
    expect(grants.isAllowed(nested, "read")).toBe(true);
  });

  it("offers file-scope options including parent directory for a file target", async () => {
    const dir = await makeScopeDirs();
    const file = join(dir, "secret.txt");
    await writeFile(file, "x");
    const events = { emit: vi.fn() };
    const grants = new GrantStore();
    let capturedOptions: string[] | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        select: vi.fn(async (message: string, options?: string[]) => {
          if (message.startsWith("Approve scope")) capturedOptions = options;
          return message.startsWith("Access") ? "Approve" : `Allow ${file} for session`;
        }),
      },
    };

    await promptAccess(events, ctx, "read", "read", file, file, grants);

    expect(capturedOptions).toEqual(["Once", `Allow ${file} for session`, `Allow ${dir} for session`]);
    expect(grants.listAllows()).toEqual([{ path: file, operation: "read", directory: false }]);

    // A file-only grant must not cover a sibling in the same directory.
    const sibling = join(dir, "other.txt");
    expect(grants.isAllowed(sibling, "read")).toBe(false);
  });

  it("grants the parent directory recursively when the parent-directory scope option is selected", async () => {
    const dir = await makeScopeDirs();
    const file = join(dir, "secret.txt");
    await writeFile(file, "x");
    const events = { emit: vi.fn() };
    const grants = new GrantStore();
    const ctx = {
      hasUI: true,
      ui: {
        select: vi.fn(async (message: string) =>
          message.startsWith("Access") ? "Approve" : `Allow ${dir} for session`,
        ),
      },
    };

    await promptAccess(events, ctx, "read", "read", file, file, grants);

    expect(grants.listAllows()).toEqual([{ path: dir, operation: "read", directory: true }]);

    const sibling = join(dir, "other.txt");
    expect(grants.isAllowed(sibling, "read")).toBe(true);
  });

  it("names the resolved (canonical) path in scope options even when the raw input path differs (e.g. via a symlink)", async () => {
    const dir = await makeScopeDirs();
    const realDir = join(dir, "real");
    await mkdir(realDir, { recursive: true });
    const file = join(realDir, "secret.txt");
    await writeFile(file, "x");
    const linkDir = join(dir, "link");
    await symlink(realDir, linkDir);
    const rawInputPath = join(linkDir, "secret.txt");
    const resolvedPath = await realpath(file);

    expect(rawInputPath).not.toBe(resolvedPath);

    const events = { emit: vi.fn() };
    const grants = new GrantStore();
    let capturedOptions: string[] | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        select: vi.fn(async (message: string, options?: string[]) => {
          if (message.startsWith("Approve scope")) capturedOptions = options;
          return message.startsWith("Access") ? "Approve" : "Once";
        }),
      },
    };

    await promptAccess(events, ctx, "read", "read", rawInputPath, resolvedPath, grants);

    expect(capturedOptions).toEqual([
      "Once",
      `Allow ${resolvedPath} for session`,
      `Allow ${dirname(resolvedPath)} for session`,
    ]);
    expect(capturedOptions?.some((opt) => opt.includes(rawInputPath))).toBe(false);
  });

  it("stores no grant when 'Once' is selected, for both directory and file targets", async () => {
    const dir = await makeScopeDirs();
    const file = join(dir, "secret.txt");
    await writeFile(file, "x");
    const events = { emit: vi.fn() };

    const dirGrants = new GrantStore();
    const dirCtx = {
      hasUI: true,
      ui: { select: vi.fn(async (message: string) => (message.startsWith("Access") ? "Approve" : "Once")) },
    };
    await promptAccess(events, dirCtx, "read", "read", dir, dir, dirGrants);
    expect(dirGrants.listAllows()).toEqual([]);

    const fileGrants = new GrantStore();
    const fileCtx = {
      hasUI: true,
      ui: { select: vi.fn(async (message: string) => (message.startsWith("Access") ? "Approve" : "Once")) },
    };
    await promptAccess(events, fileCtx, "read", "read", file, file, fileGrants);
    expect(fileGrants.listAllows()).toEqual([]);
  });
});

describe("handleToolCall", () => {
  let tempDir: string;
  let testProjectRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    ({ tempDir, testProjectRoot, outsideDir } = await makeTestDirs("pi-ward-index-test"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const events = { emit: vi.fn() };

  it("silently approves a grantable read matching the latest interactive prompt, without a UI prompt or grant", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = makeCtx(); // hasUI: false — would otherwise hard-block

    const result = await handleToolCall(
      makeReadEvent(file),
      ctx,
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `read @${file}` }),
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(grants.isAllowed(file, "read")).toBe(false);
  });

  it("works when ctx.hasUI is false — approval does not require UI", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();

    const result = await handleToolCall(
      makeReadEvent(file),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `read @${file}` }),
    );

    expect(result).toBeUndefined();
  });

  it("allows repeated matching reads during the same current prompt", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = makeCtx();
    const deps = baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `read @${file}` });

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

    const result = await handleToolCall(
      makeReadEvent(file),
      ctx,
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: "unrelated prompt text" }),
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalled();
  });

  it("shows the find pattern and search path in the access prompt (not generic 'read <path>')", async () => {
    const dir = outsideDir;
    const ctx = makeCtx(async (msg) => (msg.startsWith("Access") ? "Approve" : "Once"));
    const grants = new GrantStore();
    const findEvent = makeEvent("find", { pattern: "**/project.assets.json", path: dir });

    const result = await handleToolCall(
      findEvent,
      ctx,
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: undefined }),
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenNthCalledWith(
      1,
      `Access outside project root:\n\n  find **/project.assets.json in ${dir}`,
      ["Deny", "Approve"],
    );
  });

  it("shows the grep pattern and search path in the access prompt (not generic 'read <path>')", async () => {
    const dir = outsideDir;
    const ctx = makeCtx(async (msg) => (msg.startsWith("Access") ? "Approve" : "Once"));
    const grants = new GrantStore();

    const result = await handleToolCall(
      makeGrepEvent(dir),
      ctx,
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: undefined }),
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenNthCalledWith(1, `Access outside project root:\n\n  grep foo in ${dir}`, [
      "Deny",
      "Approve",
    ]);
  });

  it("does not consult the prompt for a no-prompt state (falls through to UI prompting)", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();

    const result = await handleToolCall(
      makeReadEvent(file),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: undefined }),
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("outside project root"),
    });
  });

  it("does not consult the prompt for write operations (unchanged behavior)", async () => {
    const file = join(outsideDir, "output.txt");
    const grants = new GrantStore();

    const result = await handleToolCall(
      makeWriteEvent(file),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `write @${file}` }),
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("outside project root"),
    });
  });

  it("does not consult the prompt for an explicit deny rule (hard deny, unchanged behavior)", async () => {
    const file = join(testProjectRoot, ".env.local");
    await writeFile(file, "SECRET=foo");
    const rules = [denyRule(".env*", testProjectRoot, tempDir)];
    const grants = new GrantStore();

    const result = await handleToolCall(
      makeReadEvent(file),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { rules, latestPrompt: `read @${file}` }),
    );

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

    const result = await handleToolCall(
      makeReadEvent(file),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `read @${file}` }),
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("denied by user (session)"),
    });
  });

  it("does not consult the prompt for a descendant of an @-marked directory blocked by an explicit deny rule", async () => {
    const dir = join(outsideDir, "notes");
    const file = join(dir, "secret.txt");
    await mkdir(dir);
    await writeFile(file, "secret");
    const rules = [denyRule("secret.txt", outsideDir, tempDir)];
    const grants = new GrantStore();

    const result = await handleToolCall(
      makeReadEvent(file),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { rules, latestPrompt: `read @${dir}` }),
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("denied by policy"),
    });
  });

  it("does not consult the prompt for a descendant of an @-marked directory blocked by a session deny", async () => {
    const dir = join(outsideDir, "notes");
    const file = join(dir, "secret.txt");
    await mkdir(dir);
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const resolved = await realpath(file);
    grants.addDeny(resolved, "read", false);

    const result = await handleToolCall(
      makeReadEvent(file),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `read @${dir}` }),
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("denied by user (session)"),
    });
  });

  it.each([true, false])("blocks grantable external reads without prompts when disabled (hasUI=%s)", async (hasUI) => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "secret");
    const grants = new GrantStore();
    const ctx = hasUI ? makeCtx(async () => "Approve") : makeCtx();
    const emitted = { emit: vi.fn() };

    const result = await handleToolCall(
      makeReadEvent(file),
      ctx,
      emitted,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `read @${file}`, disablePrompts: true }),
    );

    expect(result).toEqual({ block: true, reason: expect.stringContaining("outside project root") });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(emitted.emit).not.toHaveBeenCalled();
    expect(grants.listAllows()).toEqual([]);
  });

  it("blocks grantable external writes without opening the approval UI", async () => {
    const file = join(outsideDir, "output.txt");
    const ctx = makeCtx(async (msg) => (msg.startsWith("Access") ? "Approve" : "Once"));
    const emitted = { emit: vi.fn() };

    const result = await handleToolCall(
      makeWriteEvent(file),
      ctx,
      emitted,
      baseDeps(testProjectRoot, tempDir, new GrantStore(), { disablePrompts: true }),
    );

    expect(result).toEqual({ block: true, reason: expect.stringContaining("outside project root") });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(emitted.emit).not.toHaveBeenCalled();
  });

  it("blocks grep of an @-marked external directory without recording a call context", async () => {
    const dir = join(outsideDir, "docs");
    await mkdir(dir);
    const callContexts = new Map<string, string>();
    const ctx = makeCtx(async () => "Approve");
    const emitted = { emit: vi.fn() };

    const result = await handleToolCall(
      makeGrepEvent(dir, "disabled-grep"),
      ctx,
      emitted,
      baseDeps(testProjectRoot, tempDir, new GrantStore(), {
        latestPrompt: `look in @${dir}`,
        callContexts,
        disablePrompts: true,
      }),
    );

    expect(result?.block).toBe(true);
    expect(callContexts.size).toBe(0);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(emitted.emit).not.toHaveBeenCalled();
  });

  it("still honors explicit allows, session/project grants, and hard denies when prompts are disabled", async () => {
    const file = join(outsideDir, "allowed.txt");
    await writeFile(file, "data");
    const grants = new GrantStore();
    const ctx = makeCtx(async () => "Approve");
    const emitted = { emit: vi.fn() };
    const deps = baseDeps(testProjectRoot, tempDir, grants, { disablePrompts: true });
    const allowRule = {
      pattern: parsePattern(file),
      rawPattern: file,
      operations: "read" as const,
      effect: "allow" as const,
      configDir: tempDir,
      homeDir: tempDir,
    };
    expect(await handleToolCall(makeReadEvent(file), ctx, emitted, { ...deps, rules: [allowRule] })).toBeUndefined();
    grants.addAllow(file, "read", false);
    expect(await handleToolCall(makeReadEvent(file), ctx, emitted, deps)).toBeUndefined();
    expect(
      await handleToolCall(makeReadEvent(file), ctx, emitted, {
        ...deps,
        projectGrants: [{ resolvedPath: file, operations: "read", directory: false }],
      }),
    ).toBeUndefined();
    grants.addDeny(file, "read", false);
    expect(await handleToolCall(makeReadEvent(file), ctx, emitted, deps)).toMatchObject({ block: true });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(emitted.emit).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // call-scoped recursive directory context (callContexts)
  // ---------------------------------------------------------------------------

  it("records the approved directory's canonical root keyed by toolCallId for a grep call", async () => {
    const dir = join(outsideDir, "docs");
    await mkdir(dir, { recursive: true });
    const resolvedDir = await realpath(dir);
    const grants = new GrantStore();
    const callContexts = new Map<string, string>();

    const result = await handleToolCall(
      makeGrepEvent(dir, "call-1"),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `look in @${dir}`, callContexts }),
    );

    expect(result).toBeUndefined();
    expect(callContexts.get("call-1")).toBe(resolvedDir);
  });

  it("does not record context for a non-grep tool, even for an approved directory", async () => {
    const dir = join(outsideDir, "docs");
    await mkdir(dir, { recursive: true });
    const grants = new GrantStore();
    const callContexts = new Map<string, string>();

    // 'find' also maps to a directory-targeted read, but only grep should record context.
    const findEvent = makeEvent("find", { pattern: "*.ts", path: dir }, "call-2");

    await handleToolCall(
      findEvent,
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `look in @${dir}`, callContexts }),
    );

    expect(callContexts.size).toBe(0);
  });

  it("records the approved file's canonical path keyed by toolCallId for a grep file target", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "data");
    const resolvedFile = await realpath(file);
    const grants = new GrantStore();
    const callContexts = new Map<string, string>();

    await handleToolCall(
      makeGrepEvent(file, "call-3"),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `look in @${file}`, callContexts }),
    );

    expect(callContexts.get("call-3")).toBe(resolvedFile);
  });

  it("uses the correct call ID for each of two concurrent grep calls", async () => {
    const dirA = join(outsideDir, "a");
    const dirB = join(outsideDir, "b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const resolvedA = await realpath(dirA);
    const resolvedB = await realpath(dirB);
    const grants = new GrantStore();
    const callContexts = new Map<string, string>();
    const latestPrompt = `look in @${dirA} and @${dirB}`;

    await handleToolCall(
      makeGrepEvent(dirA, "call-a"),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt, callContexts }),
    );
    await handleToolCall(
      makeGrepEvent(dirB, "call-b"),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt, callContexts }),
    );

    expect(callContexts.get("call-a")).toBe(resolvedA);
    expect(callContexts.get("call-b")).toBe(resolvedB);
  });
});

describe("factory ward-no-prompts flag", () => {
  it("registers a default-off flag and reads its current value at tool_call, even after RPC input", async () => {
    const { tempDir, testProjectRoot, outsideDir } = await makeTestDirs("pi-ward-flag-test");
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    mockGetAgentDir.mockReturnValue(join(tempDir, "agent"));
    const handlers = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
    let disabled = false;
    const mockPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => disabled),
      on: vi.fn((name: string, handler: (event: never, ctx: never) => Promise<unknown>) => {
        handlers.set(name, handler);
      }),
      events: { emit: vi.fn() },
    };
    const originalCwd = process.cwd();
    try {
      process.chdir(testProjectRoot);
      // biome-ignore lint/suspicious/noExplicitAny: minimal structural mock of ExtensionFactory's `pi` param
      await factory(mockPi as any);
      expect(mockPi.registerFlag).toHaveBeenCalledWith("ward-no-prompts", {
        description: expect.any(String),
        type: "boolean",
        default: false,
      });
      expect(mockPi.getFlag).not.toHaveBeenCalled();
      const onInput = handlers.get("input");
      const onToolCall = handlers.get("tool_call");
      if (!onInput || !onToolCall) throw new Error("missing input/tool_call hook");
      await onInput({ source: "rpc", text: `read @${file}` } as never, {} as never);
      const ctx = makeCtx(async (msg) => (msg.startsWith("Access") ? "Approve" : "Once"));
      const call = makeReadEvent(file);
      disabled = true;
      expect(await onToolCall(call as never, ctx as never)).toMatchObject({ block: true });
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(mockPi.events.emit).not.toHaveBeenCalled();
      disabled = false;
      expect(await onToolCall(call as never, ctx as never)).toBeUndefined();
      expect(mockPi.getFlag).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("handleToolCall + handleGrepResult (end-to-end)", () => {
  let tempDir: string;
  let testProjectRoot: string;
  let outsideDir: string;
  const events = { emit: vi.fn() };

  beforeEach(async () => {
    ({ tempDir, testProjectRoot, outsideDir } = await makeTestDirs("pi-ward-e2e-test"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps a prompt-approved external file's grep output visible and cleans up the call context", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello world");
    const resolvedFile = await realpath(file);
    const grants = new GrantStore();
    const callContexts = new Map<string, string>();

    const callResult = await handleToolCall(
      makeGrepEvent(file, "call-e2e"),
      makeCtx(),
      events,
      baseDeps(testProjectRoot, tempDir, grants, { latestPrompt: `look in @${file}`, callContexts }),
    );

    expect(callResult).toBeUndefined();
    expect(callContexts.get("call-e2e")).toBe(resolvedFile);

    const resultEvent = {
      type: "tool_result",
      toolCallId: "call-e2e",
      toolName: "grep",
      input: { pattern: "hello", path: file },
      content: [{ type: "text", text: "notes.txt:1: hello world" }],
    } as unknown as ToolResultEvent;

    const grepResult = await handleGrepResult(resultEvent, grepResultDeps(testProjectRoot, grants, callContexts));

    expect(grepResult).toBeUndefined();
    expect(callContexts.has("call-e2e")).toBe(false);
  });
});

describe("handleGrepResult", () => {
  let tempDir: string;
  let testProjectRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    ({ tempDir, testProjectRoot, outsideDir } = await makeTestDirs("pi-ward-grep-result-test"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeResultEvent(toolCallId: string, path: string, text: string): ToolResultEvent {
    return {
      type: "tool_result",
      toolCallId,
      toolName: "grep",
      input: { pattern: "foo", path },
      content: [{ type: "text", text }],
      isError: false,
      details: undefined,
    } as ToolResultEvent;
  }

  it("reveals a descendant file when the approved root is recorded for this call ID", async () => {
    await writeFile(join(outsideDir, "data.txt"), "hello");
    const resolvedRoot = await realpath(outsideDir);
    const callContexts = new Map<string, string>([["call-1", resolvedRoot]]);

    const event = makeResultEvent("call-1", outsideDir, "data.txt:1: hello");
    const result = await handleGrepResult(event, grepResultDeps(testProjectRoot, new GrantStore(), callContexts));

    expect(result).toBeUndefined();
  });

  it("hides an explicitly denied descendant even under the approved root", async () => {
    await writeFile(join(outsideDir, ".env"), "SECRET=1");
    const resolvedRoot = await realpath(outsideDir);
    const callContexts = new Map<string, string>([["call-1", resolvedRoot]]);
    const rules = [denyRule(".env", testProjectRoot, tempDir)];

    const event = makeResultEvent("call-1", outsideDir, ".env:1: SECRET=1");
    const result = await handleGrepResult(
      event,
      grepResultDeps(testProjectRoot, new GrantStore(), callContexts, rules),
    );

    expect(result).toBeDefined();
    expect(result?.content[0]).toMatchObject({ type: "text" });
    const text = (result?.content[0] as { text: string }).text;
    expect(text).not.toContain("SECRET=1");
  });

  it("leaves output unchanged (baseline deny applies) with no recorded context", async () => {
    await writeFile(join(outsideDir, "data.txt"), "hello");
    const callContexts = new Map<string, string>();

    const event = makeResultEvent("call-1", outsideDir, "data.txt:1: hello");
    const result = await handleGrepResult(event, grepResultDeps(testProjectRoot, new GrantStore(), callContexts));

    expect(result).toBeDefined();
    const text = (result?.content[0] as { text: string }).text;
    expect(text).not.toContain("hello");
  });

  it("removes the call context after a successful filtering pass (no leakage to later calls)", async () => {
    await writeFile(join(outsideDir, "data.txt"), "hello");
    const resolvedRoot = await realpath(outsideDir);
    const callContexts = new Map<string, string>([["call-1", resolvedRoot]]);

    await handleGrepResult(
      makeResultEvent("call-1", outsideDir, "data.txt:1: hello"),
      grepResultDeps(testProjectRoot, new GrantStore(), callContexts),
    );

    expect(callContexts.has("call-1")).toBe(false);
  });

  it("removes the call context even when filtering throws (fail-closed, no leakage)", async () => {
    const resolvedRoot = await realpath(outsideDir);
    const callContexts = new Map<string, string>([["call-1", resolvedRoot]]);

    // Malformed content part (missing text) is cast to force an internal error path.
    const badEvent = {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "grep",
      input: { pattern: "foo", path: outsideDir },
      content: [
        {
          type: "text",
          get text(): string {
            throw new Error("boom");
          },
        },
      ],
      isError: false,
    } as unknown as ToolResultEvent;

    const result = await handleGrepResult(badEvent, grepResultDeps(testProjectRoot, new GrantStore(), callContexts));

    expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("filter error") });
    expect(callContexts.has("call-1")).toBe(false);
  });

  it("does not authorize a sibling call ID lacking its own context", async () => {
    await writeFile(join(outsideDir, "data.txt"), "hello");
    const resolvedRoot = await realpath(outsideDir);
    const callContexts = new Map<string, string>([["call-1", resolvedRoot]]);

    const event = makeResultEvent("call-2", outsideDir, "data.txt:1: hello");
    const result = await handleGrepResult(event, grepResultDeps(testProjectRoot, new GrantStore(), callContexts));

    expect(result).toBeDefined();
    const text = (result?.content[0] as { text: string }).text;
    expect(text).not.toContain("hello");
  });
});

describe("reloadWardPolicy", () => {
  let tempDir: string;
  let testHome: string;
  let testProjectRoot: string;
  let globalConfigPath: string;

  beforeEach(async () => {
    const base = join(tmpdir(), `pi-ward-reload-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(base, "home", ".pi", "agent"), { recursive: true });
    await mkdir(join(base, "project", ".pi"), { recursive: true });
    tempDir = await realpath(base);
    testHome = join(tempDir, "home");
    testProjectRoot = join(tempDir, "project");
    globalConfigPath = join(testHome, ".pi", "agent", "ward.json");
    mockGetAgentDir.mockReturnValue(join(testHome, ".pi", "agent"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads fresh rules and identities on success", async () => {
    await writeFile(globalConfigPath, JSON.stringify({ rules: [{ pattern: "~/notes.txt", effect: "deny" }] }));

    const result = await reloadWardPolicy(testProjectRoot, testHome, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(1);
      expect(result.protectedIdentities).toHaveLength(1);
    }
  });

  it("on failure, retains prior identities and folds in the replacement global config's identity", async () => {
    // Malformed JSON forces loadConfig to throw, simulating a reload failure
    // (e.g. a concurrent writer left invalid content) after the disk write
    // for the persisted rule itself already succeeded.
    await writeFile(globalConfigPath, "{ not valid json");
    const priorIdentity = { dev: 1, ino: 1 };

    const result = await reloadWardPolicy(testProjectRoot, testHome, [priorIdentity]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Invalid JSON/);
      expect(result.protectedIdentities).toContainEqual(priorIdentity);
      expect(result.protectedIdentities).toHaveLength(2);
    }
  });

  it("on failure, leaves protectedIdentities unchanged when the replacement config can't be stat'd either", async () => {
    // Skip when running as root — permission checks are bypassed.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }

    // Make the agent directory unreadable so loadConfig fails with a
    // non-ENOENT error, and the subsequent identityFor(globalConfigPath())
    // attempt also fails (can't stat through the inaccessible directory).
    const agentDir = join(testHome, ".pi", "agent");
    await chmod(agentDir, 0o000);
    const priorIdentity = { dev: 2, ino: 2 };

    try {
      const result = await reloadWardPolicy(testProjectRoot, testHome, [priorIdentity]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.protectedIdentities).toEqual([priorIdentity]);
      }
    } finally {
      await chmod(agentDir, 0o755);
    }
  });

  it("loads persistent project grants on success", async () => {
    await writeFile(join(testProjectRoot, ".pi", "ward.id"), "550e8400-e29b-41d4-a716-446655440000");
    const grantsDir = join(testHome, ".pi", "agent", "ward");
    await mkdir(grantsDir, { recursive: true });
    const target = join(testHome, "shared");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(grantsDir, "550e8400-e29b-41d4-a716-446655440000.grants.json"),
      JSON.stringify({ grants: [{ path: "~/shared/", operations: "read" }] }),
    );

    const result = await reloadWardPolicy(testProjectRoot, testHome, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projectGrants).toEqual([{ resolvedPath: target, operations: "read", directory: true }]);
      // Both ward.id and the grants file identities are folded in.
      expect(result.protectedIdentities).toHaveLength(2);
    }
  });

  it("on failure, retains the prior projectGrants passed in", async () => {
    await writeFile(globalConfigPath, "{ not valid json");
    const priorGrants = [{ resolvedPath: "/prior/path", operations: "read" as const, directory: false }];

    const result = await reloadWardPolicy(testProjectRoot, testHome, [], priorGrants);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.projectGrants).toEqual(priorGrants);
    }
  });

  it("on failure after an atomic grants-file replacement, retains the old grants identity and folds in the new one", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    await writeFile(join(testProjectRoot, ".pi", "ward.id"), id);
    const grantsDir = join(testHome, ".pi", "agent", "ward");
    await mkdir(grantsDir, { recursive: true });
    const grantsPath = join(grantsDir, `${id}.grants.json`);
    const target = join(testHome, "shared");
    await mkdir(target, { recursive: true });
    await writeFile(grantsPath, JSON.stringify({ grants: [{ path: "~/shared/", operations: "read" }] }));
    const oldGrantsStat = await stat(grantsPath);
    const oldGrantsIdentity = { dev: oldGrantsStat.dev, ino: oldGrantsStat.ino };

    // Simulate an atomic replacement (rename into place) that lands
    // malformed content under a new inode — e.g. a concurrent writer.
    const tmpPath = `${grantsPath}.tmp`;
    await writeFile(tmpPath, "not valid json");
    await rename(tmpPath, grantsPath);
    const newGrantsStat = await stat(grantsPath);
    expect(newGrantsStat.ino === oldGrantsStat.ino && newGrantsStat.dev === oldGrantsStat.dev).toBe(false);

    const result = await reloadWardPolicy(testProjectRoot, testHome, [oldGrantsIdentity], []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Invalid JSON/);
      expect(result.protectedIdentities).toContainEqual(oldGrantsIdentity);
      expect(result.protectedIdentities).toContainEqual({ dev: newGrantsStat.dev, ino: newGrantsStat.ino });
    }
  });

  it("on failure after ward.id is atomically replaced with malformed content at a new inode, retains the old identity and still protects the new one with protectRead", async () => {
    const oldId = "550e8400-e29b-41d4-a716-446655440000";
    const idPath = join(testProjectRoot, ".pi", "ward.id");
    await writeFile(idPath, oldId);
    const oldIdStat = await stat(idPath);
    const oldIdIdentity = { dev: oldIdStat.dev, ino: oldIdStat.ino, protectRead: true };

    // Simulate an atomic replacement (rename into place) that lands
    // genuinely malformed content (not a UUID) under a new inode — e.g. a
    // concurrent writer or corruption. Grants lookup can't be derived from
    // this, but the new ward.id inode must still be protected best-effort.
    const tmpPath = `${idPath}.tmp`;
    await writeFile(tmpPath, "not-a-uuid");
    await rename(tmpPath, idPath);
    const newIdStat = await stat(idPath);
    expect(newIdStat.ino === oldIdStat.ino && newIdStat.dev === oldIdStat.dev).toBe(false);

    // Force the reload itself to fail for an unrelated reason (malformed
    // global config), so identity refresh runs on the failure path while
    // the caller's prior rules/grants are left untouched by this function.
    await writeFile(globalConfigPath, "{ not valid json");
    const priorGrants = [{ resolvedPath: "/prior/path", operations: "read" as const, directory: false }];

    const result = await reloadWardPolicy(testProjectRoot, testHome, [oldIdIdentity], priorGrants);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Invalid JSON/);
      expect(result.protectedIdentities).toContainEqual(oldIdIdentity);
      expect(result.protectedIdentities).toContainEqual({
        dev: newIdStat.dev,
        ino: newIdStat.ino,
        protectRead: true,
      });
      // Prior grants are retained unchanged on a failed reload.
      expect(result.projectGrants).toEqual(priorGrants);
    }
  });
});

describe("ward command autocomplete", () => {
  type CommandConfig = {
    description: string;
    getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
    handler: (args: string, ctx: unknown) => Promise<void>;
  };

  /** Install the extension with a minimal mock `pi` and capture its `/ward` command config. */
  async function registerWardCommand(): Promise<CommandConfig> {
    const base = join(tmpdir(), `pi-ward-autocomplete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(base, { recursive: true });
    const cwd = await realpath(base);
    mockGetAgentDir.mockReturnValue(join(cwd, ".pi", "agent"));

    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      let wardConfig: CommandConfig | undefined;
      const mockPi = {
        registerTool: vi.fn(),
        registerFlag: vi.fn(),
        registerCommand: vi.fn((name: string, config: CommandConfig) => {
          if (name === "ward") wardConfig = config;
        }),
        on: vi.fn(),
        events: { emit: vi.fn() },
      };
      // biome-ignore lint/suspicious/noExplicitAny: minimal structural mock of ExtensionFactory's `pi` param
      await factory(mockPi as any);
      if (wardConfig === undefined) throw new Error("ward command was not registered");
      return wardConfig;
    } finally {
      process.chdir(originalCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it("lists 'project' among top-level subcommand completions", async () => {
    const cmd = await registerWardCommand();
    const items = cmd.getArgumentCompletions("");
    expect(items?.some((i) => i.value === "project")).toBe(true);
  });

  it("completes 'project allow', 'project list', and 'project revoke' subcommands", async () => {
    const cmd = await registerWardCommand();
    const items = cmd.getArgumentCompletions("project ");
    expect(items?.map((i) => i.value)).toEqual(
      expect.arrayContaining(["project allow", "project list", "project revoke"]),
    );
  });

  it("completes read/write operations for 'project allow'", async () => {
    const cmd = await registerWardCommand();
    const items = cmd.getArgumentCompletions("project allow ");
    expect(items?.map((i) => i.value)).toEqual(expect.arrayContaining(["project allow read", "project allow write"]));
  });

  it("does not complete operations for 'project list' or 'project revoke'", async () => {
    const cmd = await registerWardCommand();
    expect(cmd.getArgumentCompletions("project list ")).toBeNull();
    expect(cmd.getArgumentCompletions("project revoke ")).toBeNull();
  });

  it("completes read/write operations for top-level 'allow'", async () => {
    const cmd = await registerWardCommand();
    const items = cmd.getArgumentCompletions("allow ");
    expect(items?.map((i) => i.value)).toEqual(expect.arrayContaining(["allow read", "allow write"]));
  });
});

describe("factory fail-closed startup", () => {
  type ToolCallHandler = (
    event: ToolCallEvent,
    ctx: unknown,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  type WardConfig = {
    handler: (args: string, ctx: { ui: { notify: (message: string, type?: string) => void } }) => Promise<void>;
  };

  /** Install the extension with a broken on-disk state and capture its registered hooks/command. */
  async function setupBrokenFactory(setup: (cwd: string) => Promise<void>): Promise<{
    cwd: string;
    registerTool: ReturnType<typeof vi.fn>;
    onToolCall: ToolCallHandler;
    wardConfig: WardConfig;
  }> {
    const base = join(tmpdir(), `pi-ward-startup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(base, ".pi", "agent"), { recursive: true });
    const cwd = await realpath(base);
    mockGetAgentDir.mockReturnValue(join(cwd, ".pi", "agent"));
    await setup(cwd);

    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      let wardConfig: WardConfig | undefined;
      const handlers = new Map<string, ToolCallHandler>();
      const registerTool = vi.fn();
      const mockPi = {
        registerTool,
        registerFlag: vi.fn(),
        registerCommand: vi.fn((name: string, config: WardConfig) => {
          if (name === "ward") wardConfig = config;
        }),
        getFlag: vi.fn(() => false),
        on: vi.fn((event: string, handler: ToolCallHandler) => {
          handlers.set(event, handler);
        }),
        events: { emit: vi.fn() },
      };
      // biome-ignore lint/suspicious/noExplicitAny: minimal structural mock of ExtensionFactory's `pi` param
      await factory(mockPi as any);
      const onToolCall = handlers.get("tool_call");
      if (wardConfig === undefined || onToolCall === undefined) {
        throw new Error("factory did not register the ward command and/or tool_call hook");
      }
      return { cwd, registerTool, onToolCall, wardConfig };
    } finally {
      process.chdir(originalCwd);
    }
  }

  async function expectBlocksGuardedReadsAndWardCommands(
    cwd: string,
    registerTool: ReturnType<typeof vi.fn>,
    onToolCall: ToolCallHandler,
    wardConfig: WardConfig,
    expectedErrorFragment: RegExp,
  ): Promise<void> {
    // Guarded tools are still registered.
    expect(registerTool).toHaveBeenCalledTimes(2);

    // A guarded read is blocked with a persistent policy-load error...
    const file = join(cwd, "README.md");
    await writeFile(file, "hello");
    const readEvent = { type: "tool_call", toolCallId: "t1", toolName: "read", input: { path: file } } as ToolCallEvent;
    const ctx = { hasUI: false, ui: { select: vi.fn() } };
    const result = await onToolCall(readEvent, ctx);
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(expectedErrorFragment);

    // ...while a non-file/unrecognized tool is unaffected.
    const bashEvent = {
      type: "tool_call",
      toolCallId: "t2",
      toolName: "bash",
      input: { command: "ls" },
    } as ToolCallEvent;
    expect(await onToolCall(bashEvent, ctx)).toBeUndefined();

    // /ward commands refuse to run and report repair/reload required, rather
    // than reporting or mutating normal policy state.
    const notifications: Array<{ message: string; type?: string }> = [];
    await wardConfig.handler("list", {
      ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toMatch(expectedErrorFragment);
    expect(notifications[0]?.message).toMatch(/reload.*restart/);
  }

  it("blocks guarded reads and disables /ward when the global config is malformed", async () => {
    const { cwd, registerTool, onToolCall, wardConfig } = await setupBrokenFactory(async (dir) => {
      await writeFile(join(dir, ".pi", "agent", "ward.json"), "{ not valid json");
    });
    try {
      await expectBlocksGuardedReadsAndWardCommands(cwd, registerTool, onToolCall, wardConfig, /Invalid JSON/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks guarded reads and disables /ward when the project ward.id is malformed", async () => {
    const { cwd, registerTool, onToolCall, wardConfig } = await setupBrokenFactory(async (dir) => {
      await mkdir(join(dir, ".pi"), { recursive: true });
      await writeFile(join(dir, ".pi", "ward.id"), "not-a-uuid");
    });
    try {
      await expectBlocksGuardedReadsAndWardCommands(cwd, registerTool, onToolCall, wardConfig, /canonical UUID/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
