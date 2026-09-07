import { link, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wardCommandHandler } from "../src/command.js";
import { GrantStore } from "../src/grants.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";
import type { ProtectedIdentity } from "../src/self-protect.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

const mockGetAgentDir = vi.mocked(getAgentDir);

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tempDir: string;
let projectRoot: string;
let homeDir: string;
let outsideDir: string;

beforeEach(async () => {
  const base = join(tmpdir(), `pi-ward-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(base, "project"), { recursive: true });
  await mkdir(join(base, "home", "outside"), { recursive: true });
  tempDir = await realpath(base);
  projectRoot = join(tempDir, "project");
  homeDir = join(tempDir, "home");
  outsideDir = join(homeDir, "outside");
  mockGetAgentDir.mockReturnValue(join(homeDir, ".pi", "agent"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

interface Notification {
  message: string;
  type?: "info" | "warning" | "error";
}

function makeCtx() {
  const notifications: Notification[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
  };
}

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
    homeDir,
  };
}

async function run(
  args: string,
  grants: GrantStore,
  rules: ParsedRule[] = [],
  protectedIdentities: ProtectedIdentity[] = [],
) {
  const ctx = makeCtx();
  await wardCommandHandler(args, ctx, { rules, projectRoot, homeDir, grants, protectedIdentities });
  return ctx.notifications;
}

// ---------------------------------------------------------------------------
// /ward allow
// ---------------------------------------------------------------------------

describe("/ward allow", () => {
  it("grants read access to an existing file (default operation)", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    const notes = await run(`allow ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(store.isAllowed(resolvedFile, "read")).toBe(true);
    expect(store.isAllowed(resolvedFile, "write")).toBe(false);
  });

  it("grants read when 'read' is explicit", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    const notes = await run(`allow read ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(store.isAllowed(resolvedFile, "read")).toBe(true);
  });

  it("grants write (and read) when 'write' is specified", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    await run(`allow write ${file}`, store);
    expect(store.isAllowed(resolvedFile, "read")).toBe(true);
    expect(store.isAllowed(resolvedFile, "write")).toBe(true);
  });

  it("preserves internal repeated whitespace in a literal path", async () => {
    const file = join(outsideDir, "my  file.txt");
    await writeFile(file, "hello");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    await run(`allow write ${file}`, store);
    expect(store.isAllowed(resolvedFile, "write")).toBe(true);
  });

  it("sets directory=true for a trailing-slash path", async () => {
    const store = new GrantStore();
    const resolvedOutside = await realpath(outsideDir);

    const notes = await run(`allow ${outsideDir}/`, store);
    expect(notes[0]?.type).toBe("info");
    const allows = store.listAllows();
    expect(allows).toHaveLength(1);
    expect(allows[0]?.directory).toBe(true);
    // Directory grant covers files underneath.
    expect(store.isAllowed(join(resolvedOutside, "deep.txt"), "read")).toBe(true);
  });

  it("sets directory=true for an existing directory path (no trailing slash)", async () => {
    const store = new GrantStore();
    const resolvedOutside = await realpath(outsideDir);

    await run(`allow ${outsideDir}`, store);
    const allows = store.listAllows();
    expect(allows).toHaveLength(1);
    expect(allows[0]?.directory).toBe(true);
    expect(store.isAllowed(join(resolvedOutside, "file.txt"), "read")).toBe(true);
  });

  it("expands ~ in the path", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    // outsideDir = homeDir/outside, so ~/outside/notes.txt should work
    await run(`allow ~/outside/notes.txt`, store);
    expect(store.isAllowed(resolvedFile, "read")).toBe(true);
  });

  it("rejects when path is denied by an explicit rule", async () => {
    const file = join(outsideDir, ".env.local");
    await writeFile(file, "SECRET=x");
    const store = new GrantStore();

    const rules = [makeRule(".env*", "deny", projectRoot)];
    const notes = await run(`allow ${file}`, store, rules);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/explicit policy rule/);
    expect(store.listAllows()).toHaveLength(0);
  });

  it("shows usage when no path is given", async () => {
    const store = new GrantStore();
    const notes = await run("allow", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Usage/);
  });

  it("resolves relative paths from project root", async () => {
    const store = new GrantStore();
    const subDir = join(projectRoot, "src");
    await mkdir(subDir, { recursive: true });

    await run("allow src", store);
    const allows = store.listAllows();
    expect(allows).toHaveLength(1);
    expect(allows[0]?.path).toBe(subDir);
  });

  it("warns when path cannot be resolved (broken symlink)", async () => {
    const broken = join(outsideDir, "broken-link");
    await symlink(join(outsideDir, "nonexistent-target"), broken);
    const store = new GrantStore();

    const notes = await run(`allow ${broken}`, store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Cannot resolve path/);
    expect(store.listAllows()).toHaveLength(0);
  });

  it("rejects glob characters in path", async () => {
    const store = new GrantStore();
    const notes = await run("allow ~/foo/*.ts", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Glob patterns are not supported/);
    expect(store.listAllows()).toHaveLength(0);
  });

  it("rejects write grants to self-protected paths", async () => {
    const store = new GrantStore();
    const protectedPiDir = join(outsideDir, ".pi");
    await mkdir(protectedPiDir, { recursive: true });
    const protectedFile = join(protectedPiDir, "ward.json");
    await writeFile(protectedFile, "{}");
    const notes = await run(`allow write ${protectedFile}`, store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/ward config file/);
    expect(store.listAllows()).toHaveLength(0);
  });

  it("rejects write grants to a hardlink alias of an active config identity", async () => {
    const store = new GrantStore();
    // Config lives outside the .pi structural path entirely — only its
    // active on-disk identity marks it as protected.
    const activeConfig = join(outsideDir, "active-config.json");
    await writeFile(activeConfig, "{}");
    const st = await stat(activeConfig);
    const protectedIdentities: ProtectedIdentity[] = [{ dev: st.dev, ino: st.ino }];

    const alias = join(outsideDir, "alias.json");
    await link(activeConfig, alias);

    const notes = await run(`allow write ${alias}`, store, [], protectedIdentities);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/ward config file/);
    expect(store.listAllows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /ward deny
// ---------------------------------------------------------------------------

describe("/ward deny", () => {
  it("adds a deny for a file (default operation blocks read+write)", async () => {
    const file = join(outsideDir, "secrets.txt");
    await writeFile(file, "data");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    const notes = await run(`deny ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(store.isDenied(resolvedFile, "read")).toBe(true);
    expect(store.isDenied(resolvedFile, "write")).toBe(true);
  });

  it("denies read when 'read' is explicit (blocks read+write)", async () => {
    const file = join(outsideDir, "secrets.txt");
    await writeFile(file, "data");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    const notes = await run(`deny read ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(store.isDenied(resolvedFile, "read")).toBe(true);
    expect(store.isDenied(resolvedFile, "write")).toBe(true);
  });

  it("denies write only when 'write' is specified (read still permitted)", async () => {
    const file = join(outsideDir, "secrets.txt");
    await writeFile(file, "data");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    const notes = await run(`deny write ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(store.isDenied(resolvedFile, "write")).toBe(true);
    expect(store.isDenied(resolvedFile, "read")).toBe(false);
  });

  it("preserves internal repeated whitespace in a literal path", async () => {
    const file = join(outsideDir, "my  file.txt");
    await writeFile(file, "data");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    const notes = await run(`deny write ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(store.isDenied(resolvedFile, "write")).toBe(true);
  });

  it("adds a directory deny with trailing slash", async () => {
    const store = new GrantStore();
    const resolvedOutside = await realpath(outsideDir);

    await run(`deny ${outsideDir}/`, store);
    const denies = store.listDenies();
    expect(denies).toHaveLength(1);
    expect(denies[0]?.directory).toBe(true);
    expect(store.isDenied(join(resolvedOutside, "deep.txt"), "read")).toBe(true);
  });

  it("expands ~ in path", async () => {
    const file = join(outsideDir, "secrets.txt");
    await writeFile(file, "data");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    await run(`deny ~/outside/secrets.txt`, store);
    expect(store.isDenied(resolvedFile, "read")).toBe(true);
  });

  it("shows usage when no path is given", async () => {
    const store = new GrantStore();
    const notes = await run("deny", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Usage/);
  });

  it("warns when path cannot be resolved (broken symlink)", async () => {
    const broken = join(outsideDir, "broken-link");
    await symlink(join(outsideDir, "nonexistent-target"), broken);
    const store = new GrantStore();

    const notes = await run(`deny ${broken}`, store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Cannot resolve path/);
    expect(store.listDenies()).toHaveLength(0);
  });

  it("rejects glob characters in path", async () => {
    const store = new GrantStore();
    const notes = await run("deny ~/foo?.ts", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Glob patterns are not supported/);
    expect(store.listDenies()).toHaveLength(0);
  });

  it("stores a valid session deny for a path inside project root", async () => {
    const store = new GrantStore();
    const file = join(projectRoot, "src", "index.ts");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(file, "");
    const resolvedFile = await realpath(file);
    const notes = await run(`deny ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(store.isDenied(resolvedFile, "read")).toBe(true);
    expect(store.isDenied(resolvedFile, "write")).toBe(true);
  });

  it("stores a valid session deny for a path already denied by explicit rule", async () => {
    const store = new GrantStore();
    const file = join(outsideDir, ".env");
    await writeFile(file, "");
    const resolvedFile = await realpath(file);
    const rules = [makeRule(".env", "deny", projectRoot)];
    const notes = await run(`deny ${file}`, store, rules);
    expect(notes[0]?.type).toBe("info");
    expect(store.isDenied(resolvedFile, "read")).toBe(true);
    expect(store.listDenies()).toHaveLength(1);
  });

  it("stores a valid session deny for a path allowed by an explicit rule", async () => {
    // A path outside project root with an allow-read rule → read is rule-allowed.
    // Session deny must still be stored and take precedence at checkPath time.
    const store = new GrantStore();
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "");
    const resolvedFile = await realpath(file);
    const rules = [makeRule("notes.txt", "allow", outsideDir, "read")];
    const notes = await run(`deny ${file}`, store, rules);
    expect(notes[0]?.type).toBe("info");
    expect(notes[0]?.message).toMatch(/Denied .*access/);
    expect(store.isDenied(resolvedFile, "read")).toBe(true);
    expect(store.listDenies()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// /ward list
// ---------------------------------------------------------------------------

describe("/ward list", () => {
  it("reports no active grants when store is empty", async () => {
    const store = new GrantStore();
    const notes = await run("list", store);
    expect(notes[0]?.type).toBe("info");
    expect(notes[0]?.message).toMatch(/No active/);
  });

  it("shows allows and denies", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);

    store.addAllow(resolvedFile, "read", false);
    store.addDeny(join(homeDir, "secrets"), "read", true);

    const notes = await run("list", store);
    expect(notes[0]?.type).toBe("info");
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/Session decisions:/);
    expect(msg).toMatch(/allow\s+read/);
    expect(msg).toMatch(/deny/);
  });

  it("shows ~ paths in ~ form", async () => {
    const store = new GrantStore();
    // homeDir/outside is ~/outside in display
    store.addAllow(join(homeDir, "outside"), "write", true);

    const notes = await run("list", store);
    expect(notes[0]?.message).toMatch(/~/);
  });
});

// ---------------------------------------------------------------------------
// /ward revoke
// ---------------------------------------------------------------------------

describe("/ward revoke", () => {
  it("removes an existing grant", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addAllow(resolvedFile, "read", false);

    const notes = await run(`revoke ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    expect(notes[0]?.message).toMatch(/Revoked/);
    expect(store.isAllowed(resolvedFile, "read")).toBe(false);
  });

  it("warns when no grant/deny exists for the path", async () => {
    const file = join(outsideDir, "nobody.txt");
    await writeFile(file, "data");
    const store = new GrantStore();

    const notes = await run(`revoke ${file}`, store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/No active/);
  });

  it("shows usage when no path given", async () => {
    const store = new GrantStore();
    const notes = await run("revoke", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Usage/);
  });

  it("rejects glob characters in path", async () => {
    const store = new GrantStore();
    const notes = await run("revoke ~/foo[0].ts", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Glob patterns are not supported/);
  });

  it("warns when path cannot be resolved (broken symlink)", async () => {
    const broken = join(outsideDir, "broken-revoke");
    await symlink(join(outsideDir, "nonexistent"), broken);
    const store = new GrantStore();
    const notes = await run(`revoke ${broken}`, store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Cannot resolve path/);
  });
});

// ---------------------------------------------------------------------------
// /ward status
// ---------------------------------------------------------------------------

describe("/ward status", () => {
  it("reports baseline allow for path inside project root", async () => {
    const file = join(projectRoot, "src", "index.ts");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(file, "");
    const store = new GrantStore();

    const notes = await run(`status ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/read: allowed/);
    expect(msg).toMatch(/write: allowed/);
  });

  it("reports baseline deny (grantable) for path outside project root", async () => {
    const file = join(outsideDir, "data.txt");
    await writeFile(file, "x");
    const store = new GrantStore();

    const notes = await run(`status ${file}`, store);
    expect(notes[0]?.type).toBe("info");
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/grantable/);
  });

  it("reports explicit rule deny for a matching path", async () => {
    const file = join(outsideDir, ".env.local");
    await writeFile(file, "SECRET=x");
    const store = new GrantStore();
    const rules = [makeRule(".env*", "deny", projectRoot)];

    const notes = await run(`status ${file}`, store, rules);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/denied by rule/);
    expect(msg).toMatch(/not grantable/);
  });

  it("reports session grant when active", async () => {
    const file = join(outsideDir, "data.txt");
    await writeFile(file, "x");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addAllow(resolvedFile, "read", false);

    const notes = await run(`status ${file}`, store);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/allowed by session grant/);
  });

  it("reports session deny when active", async () => {
    const file = join(outsideDir, "data.txt");
    await writeFile(file, "x");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addDeny(resolvedFile, "read", false);

    const notes = await run(`status ${file}`, store);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/denied by session deny/);
  });

  it("reports project-local read deny before baseline allow (both operations denied)", async () => {
    const file = join(projectRoot, "src", "index.ts");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(file, "");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addDeny(resolvedFile, "read", false);

    const notes = await run(`status ${file}`, store);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/read: denied by session deny/);
    expect(msg).toMatch(/write: denied by session deny/);
  });

  it("reports project-local write deny before baseline allow (read allowed, write denied)", async () => {
    const file = join(projectRoot, "src", "index.ts");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(file, "");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addDeny(resolvedFile, "write", false);

    const notes = await run(`status ${file}`, store);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/read: allowed by baseline/);
    expect(msg).toMatch(/write: denied by session deny/);
  });

  it("reports session deny before an explicit rule allow", async () => {
    const file = join(outsideDir, "readme.md");
    await writeFile(file, "");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    store.addDeny(resolvedFile, "read", false);
    const rules = [makeRule("readme.md", "allow", outsideDir, "read")];

    const notes = await run(`status ${file}`, store, rules);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/read: denied by session deny/);
  });

  it("shows usage when no path given", async () => {
    const store = new GrantStore();
    const notes = await run("status", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Usage/);
  });

  it("rejects glob characters in path", async () => {
    const store = new GrantStore();
    const notes = await run("status ~/foo].ts", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Glob patterns are not supported/);
  });

  it("reports self-protected write denial", async () => {
    const store = new GrantStore();
    const piDir = join(projectRoot, ".pi");
    await mkdir(piDir, { recursive: true });
    const file = join(piDir, "ward.json");
    await writeFile(file, "{}");
    const notes = await run(`status ${file}`, store);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/write: denied \(ward config file/);
  });

  it("reports the same self-protected write denial for a symlink alias of an active config", async () => {
    const store = new GrantStore();
    const activeConfig = join(outsideDir, "active-config.json");
    await writeFile(activeConfig, "{}");
    const st = await stat(activeConfig);
    const protectedIdentities: ProtectedIdentity[] = [{ dev: st.dev, ino: st.ino }];

    const alias = join(outsideDir, "alias-status.json");
    await symlink(activeConfig, alias);

    const notes = await run(`status ${alias}`, store, [], protectedIdentities);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/write: denied \(ward config file/);
  });

  it("reports allowed by rule", async () => {
    const store = new GrantStore();
    const file = join(outsideDir, "readme.md");
    await writeFile(file, "");
    const rules = [makeRule("readme.md", "allow", outsideDir, "read")];
    const notes = await run(`status ${file}`, store, rules);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/allowed by rule/);
    expect(msg).toMatch(/readme\.md/);
  });

  it("warns when path cannot be resolved (broken symlink)", async () => {
    const broken = join(outsideDir, "broken-status");
    await symlink(join(outsideDir, "nonexistent"), broken);
    const store = new GrantStore();
    const notes = await run(`status ${broken}`, store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Cannot resolve path/);
  });
});

// ---------------------------------------------------------------------------
// /ward project
// ---------------------------------------------------------------------------

function globalConfigFile(): string {
  return join(homeDir, ".pi", "agent", "ward.json");
}

async function writeGlobalConfig(content: unknown): Promise<void> {
  await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
  await writeFile(globalConfigFile(), JSON.stringify(content), "utf-8");
}

interface ProjectRunOpts {
  hasUI?: boolean;
  selectResult?: string | undefined;
  rules?: ParsedRule[];
  protectedIdentities?: ProtectedIdentity[];
  reloadPolicy?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

function makeProjectCtx(opts: ProjectRunOpts) {
  const notifications: Notification[] = [];
  const selectCalls: Array<{ message: string; options: string[] }> = [];
  return {
    notifications,
    selectCalls,
    hasUI: opts.hasUI ?? true,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      select: async (message: string, options: string[]) => {
        selectCalls.push({ message, options });
        return opts.selectResult ?? "Persist";
      },
    },
  };
}

async function runProject(args: string, opts: ProjectRunOpts = {}) {
  const ctx = makeProjectCtx(opts);
  const grants = new GrantStore();
  await wardCommandHandler(args, ctx, {
    rules: opts.rules ?? [],
    projectRoot,
    homeDir,
    grants,
    protectedIdentities: opts.protectedIdentities ?? [],
    reloadPolicy: opts.reloadPolicy,
  });
  return ctx;
}

describe("/ward project allow|deny", () => {
  it("persists an allow rule after confirmation and reports success", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const reloadPolicy = vi.fn(async () => ({ ok: true as const }));

    const ctx = await runProject(`project allow ${file}`, { selectResult: "Persist", reloadPolicy });

    expect(ctx.notifications.at(-1)?.type).toBe("info");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Persisted allow read rule/);
    expect(ctx.notifications.at(-1)?.message).toMatch(/reloaded/i);
    expect(reloadPolicy).toHaveBeenCalledOnce();

    const written = JSON.parse(await readFile(globalConfigFile(), "utf-8"));
    expect(written.rules).toHaveLength(1);
    expect(written.rules[0]).toMatchObject({ effect: "allow", operations: "read" });
  });

  it("persists a write rule when 'write' operation is specified", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    await runProject(`project allow write ${file}`, { selectResult: "Persist" });

    const written = JSON.parse(await readFile(globalConfigFile(), "utf-8"));
    expect(written.rules[0]).toMatchObject({ effect: "allow", operations: "write" });
  });

  it("persists a deny rule after confirmation", async () => {
    const file = join(outsideDir, "secret.txt");
    await writeFile(file, "data");

    const ctx = await runProject(`project deny ${file}`, { selectResult: "Persist" });

    expect(ctx.notifications.at(-1)?.message).toMatch(/Persisted deny read rule/);
    const written = JSON.parse(await readFile(globalConfigFile(), "utf-8"));
    expect(written.rules[0]).toMatchObject({ effect: "deny", operations: "read" });
  });

  it("shows an exact preview and writes nothing when the user cancels", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = await runProject(`project allow ${file}`, { selectResult: "Cancel" });

    expect(ctx.selectCalls).toHaveLength(1);
    expect(ctx.selectCalls[0]?.options).toEqual(["Cancel", "Persist"]);
    const msg = ctx.selectCalls[0]?.message ?? "";
    expect(msg).toMatch(/Persist ward policy change/);
    expect(msg).toMatch(/effect: allow/);
    expect(msg).toMatch(/operation: read/);
    expect(msg).toMatch(/pattern: /);
    expect(msg).toMatch(/projectRoot condition: /);
    expect(msg).toMatch(/destination: /);
    expect(ctx.notifications.at(-1)?.type).toBe("info");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Cancelled/);
    await expect(readFile(globalConfigFile(), "utf-8")).rejects.toThrow();
  });

  it("refuses to persist without an interactive UI, but list still works", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = await runProject(`project allow ${file}`, { hasUI: false });
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/interactive session/);
    await expect(readFile(globalConfigFile(), "utf-8")).rejects.toThrow();

    const listCtx = await runProject("project list", { hasUI: false });
    expect(listCtx.notifications[0]?.type).toBe("info");
  });

  it("shows usage when no path is given", async () => {
    const ctx = await runProject("project allow");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Usage: \/ward project allow/);
  });

  it("rejects glob characters in path", async () => {
    const ctx = await runProject("project allow ~/foo/*.ts");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Glob patterns are not supported/);
  });

  it("rejects unresolvable paths (broken symlink)", async () => {
    const broken = join(outsideDir, "broken-project-link");
    await symlink(join(outsideDir, "nonexistent-target"), broken);

    const ctx = await runProject(`project allow ${broken}`);
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Cannot resolve path/);
  });

  it("rejects a write rule targeting a self-protected config path", async () => {
    const protectedDir = join(outsideDir, ".pi");
    await mkdir(protectedDir, { recursive: true });
    const protectedFile = join(protectedDir, "ward.json");
    await writeFile(protectedFile, "{}");

    const ctx = await runProject(`project allow write ${protectedFile}`);
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/write-protected/);
  });

  it("rejects when the candidate would be shadowed by an existing global rule", async () => {
    await writeGlobalConfig({ rules: [{ pattern: "~/outside/", effect: "allow" }] });
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");

    const ctx = await runProject(`project allow ${file}`);
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/shadowed by an earlier global rule/);
  });

  it("rejects persisting an allow when an explicit deny rule already governs the path", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    const projectDenyRule = makeRule("notes.txt", "deny", projectRoot);

    const ctx = await runProject(`project allow ${file}`, { rules: [projectDenyRule] });
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/explicit deny rule/);
  });

  it("discloses (without blocking) a project rule that a persisted deny would supersede", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    const projectRule = makeRule("notes.txt", "deny", projectRoot);

    const reloadPolicy = vi.fn(async () => ({ ok: true as const }));
    const ctx = await runProject(`project deny ${file}`, {
      selectResult: "Persist",
      rules: [projectRule],
      reloadPolicy,
    });

    expect(ctx.selectCalls[0]?.message).toMatch(/supersede/);
    expect(ctx.notifications.at(-1)?.type).toBe("info");
  });

  it("reports a persistence success with a reload-failure fallback message", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const reloadPolicy = vi.fn(async () => ({ ok: false as const, reason: "boom" }));

    const ctx = await runProject(`project allow ${file}`, { selectResult: "Persist", reloadPolicy });

    expect(ctx.notifications.at(-1)?.type).toBe("warning");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Persisted allow read rule/);
    expect(ctx.notifications.at(-1)?.message).toMatch(/boom/);
    expect(ctx.notifications.at(-1)?.message).toMatch(/restart to apply/);

    // The disk write itself succeeded despite the reload failure.
    const written = JSON.parse(await readFile(globalConfigFile(), "utf-8"));
    expect(written.rules).toHaveLength(1);
  });
});

describe("/ward project list", () => {
  it("reports no persisted rules when the global config is empty", async () => {
    const ctx = await runProject("project list");
    expect(ctx.notifications[0]?.type).toBe("info");
    expect(ctx.notifications[0]?.message).toMatch(/No persisted rules/);
  });

  it("lists only rules scoped to the active project, filtering out other projects' rules", async () => {
    const otherProject = join(tempDir, "other-project");
    await mkdir(otherProject, { recursive: true });

    await writeGlobalConfig({
      rules: [
        { pattern: "~/outside/mine.txt", effect: "allow", operations: "read", projectRoot },
        { pattern: "~/outside/theirs.txt", effect: "deny", operations: "read", projectRoot: otherProject },
      ],
    });

    const ctx = await runProject("project list");
    const msg = ctx.notifications[0]?.message ?? "";
    expect(msg).toMatch(/mine\.txt/);
    expect(msg).not.toMatch(/theirs\.txt/);
  });

  it("does not mutate anything and never asks for confirmation", async () => {
    await writeGlobalConfig({ rules: [{ pattern: "~/outside/mine.txt", effect: "allow", projectRoot }] });
    const before = await readFile(globalConfigFile(), "utf-8");

    const ctx = await runProject("project list", { selectResult: "Cancel" });

    expect(ctx.selectCalls).toHaveLength(0);
    const after = await readFile(globalConfigFile(), "utf-8");
    expect(after).toBe(before);
  });
});

describe("/ward project unknown subcommand", () => {
  it("shows project usage for an unrecognised subcommand", async () => {
    const ctx = await runProject("project bogus");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Usage: \/ward project/);
  });
});

describe("/ward project path parsing (whitespace preservation)", () => {
  it("persists a path with repeated internal spaces exactly", async () => {
    const dirWithSpaces = join(outsideDir, "my  dir");
    await mkdir(dirWithSpaces, { recursive: true });
    const file = join(dirWithSpaces, "a  b.txt");
    await writeFile(file, "hello");

    const reloadPolicy = vi.fn(async () => ({ ok: true as const }));
    const ctx = await runProject(`project allow ${file}`, { selectResult: "Persist", reloadPolicy });

    expect(ctx.notifications.at(-1)?.type).toBe("info");
    const written = JSON.parse(await readFile(globalConfigFile(), "utf-8"));
    expect(written.rules).toHaveLength(1);
    expect(written.rules[0].pattern).toMatch(/my {2}dir\/a {2}b\.txt$/);
  });
});

describe("/ward project malformed global config handling", () => {
  it("surfaces a warning (without throwing) for mutation when the global config is invalid JSON", async () => {
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await writeFile(globalConfigFile(), "{ not valid json", "utf-8");
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = await runProject(`project allow ${file}`);

    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Invalid JSON/);
  });

  it("surfaces a warning (without throwing) for mutation when the global config fails schema validation", async () => {
    await writeGlobalConfig({ rules: [{ pattern: 123, effect: "allow" }] });
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = await runProject(`project allow ${file}`);

    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/schema validation failed|instancePath|must be/i);
  });

  it("surfaces a warning (without throwing) for list when the global config is invalid JSON", async () => {
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await writeFile(globalConfigFile(), "{ not valid json", "utf-8");

    const ctx = await runProject("project list");

    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Invalid JSON/);
  });
});

describe("/ward project confirm failure", () => {
  it("reports a warning and writes nothing when confirm throws", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = makeProjectCtx({});
    ctx.ui.select = vi.fn(async () => {
      throw new Error("confirm boom");
    });
    const grants = new GrantStore();

    await wardCommandHandler(`project allow ${file}`, ctx, {
      rules: [],
      projectRoot,
      homeDir,
      grants,
      protectedIdentities: [],
    });

    expect(ctx.notifications.at(-1)?.type).toBe("warning");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Confirmation failed/);
    await expect(readFile(globalConfigFile(), "utf-8")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe("unknown subcommand", () => {
  it("shows usage for unrecognised subcommand", async () => {
    const store = new GrantStore();
    const notes = await run("bogus", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Usage/);
  });

  it("shows usage when args are empty", async () => {
    const store = new GrantStore();
    const notes = await run("", store);
    expect(notes[0]?.type).toBe("warning");
    expect(notes[0]?.message).toMatch(/Usage/);
  });
});

// ---------------------------------------------------------------------------
// Integration sequences
// ---------------------------------------------------------------------------

describe("/ward integration sequences", () => {
  it("allow then status shows session grant", async () => {
    const store = new GrantStore();
    const file = join(outsideDir, "granted.txt");
    await writeFile(file, "");
    await run(`allow ${file}`, store);
    const notes = await run(`status ${file}`, store);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/allowed by session grant/);
  });

  it("deny then revoke then status shows grantable", async () => {
    const store = new GrantStore();
    const file = join(outsideDir, "revokable.txt");
    await writeFile(file, "");
    await run(`deny ${file}`, store);
    expect(store.listDenies()).toHaveLength(1);
    await run(`revoke ${file}`, store);
    expect(store.listDenies()).toHaveLength(0);
    const notes = await run(`status ${file}`, store);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/grantable/);
  });
});
