import { link, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wardCommandHandler } from "../src/command.js";
import { GrantStore } from "../src/grants.js";
import { checkPath } from "../src/guard.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedGrant } from "../src/project-grants.js";
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
  projectGrants: ParsedGrant[] = [],
) {
  const ctx = makeCtx();
  await wardCommandHandler(args, ctx, { rules, projectRoot, homeDir, grants, protectedIdentities, projectGrants });
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

  it("grants write over an ordinary global deny rule and reports the session grant", async () => {
    const file = join(outsideDir, ".env.local");
    await writeFile(file, "SECRET=x");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    const rules = [makeRule(".env*", "deny", outsideDir)];

    const before = await checkPath("read", file, "read", rules, projectRoot, store);
    expect(before.allowed).toBe(false);
    if (!before.allowed) expect(before.grantable).toBe(false);

    const notes = await run(`allow write ${file}`, store, rules);
    expect(notes[0]?.type).toBe("info");
    expect(store.listAllows()).toEqual([{ path: resolvedFile, operation: "write", directory: false }]);
    expect((await checkPath("read", file, "read", rules, projectRoot, store)).allowed).toBe(true);
    expect((await checkPath("write", file, "write", rules, projectRoot, store)).allowed).toBe(true);

    const status = await run(`status ${file}`, store, rules);
    expect(status[0]?.type).toBe("info");
    expect(status[0]?.message).toMatch(/read: allowed by session grant/);
    expect(status[0]?.message).toMatch(/write: allowed by session grant/);
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
    const protectedFile = join(protectedPiDir, "ward.id");
    await writeFile(protectedFile, "550e8400-e29b-41d4-a716-446655440000");
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

  it("rejects a read grant targeting ward.id (self-protection blocks reads regardless of operation)", async () => {
    const store = new GrantStore();
    const piDir = join(projectRoot, ".pi");
    await mkdir(piDir, { recursive: true });
    const wardId = join(piDir, "ward.id");
    await writeFile(wardId, "some-identity");

    const notes = await run(`allow read ${wardId}`, store);
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
    expect(msg).toMatch(/explicit \/ward allow required \(no interactive prompt\)/);
  });

  it("reports an explicit deny for a descendant despite a prompt-created directory grant", async () => {
    const blocked = join(outsideDir, ".env.local");
    const sibling = join(outsideDir, "notes.txt");
    await writeFile(blocked, "SECRET=x");
    await writeFile(sibling, "hello");
    const store = new GrantStore();
    const rules = [makeRule(".env*", "deny", outsideDir)];

    const directory = await checkPath("read", outsideDir, "read", rules, projectRoot, store);
    expect(directory.allowed).toBe(false);
    if (!directory.allowed) expect(directory.grantable).toBe(true);
    store.addAllow(await realpath(outsideDir), "read", true);

    const denied = await run(`status ${blocked}`, store, rules);
    expect(denied[0]?.type).toBe("info");
    expect(denied[0]?.message).toMatch(/read: denied by rule/);
    expect(denied[0]?.message).not.toMatch(/read: allowed by session grant/);

    const allowed = await run(`status ${sibling}`, store, rules);
    expect(allowed[0]?.message).toMatch(/read: allowed by session grant/);
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

  it("reports a persistent project grant that overrides a global deny rule", async () => {
    const file = join(outsideDir, "shared.txt");
    await writeFile(file, "x");
    const store = new GrantStore();
    const resolvedFile = await realpath(file);
    const rules = [makeRule("shared.txt", "deny", outsideDir)];
    const projectGrants: ParsedGrant[] = [{ resolvedPath: resolvedFile, operations: "read", directory: false }];

    const notes = await run(`status ${file}`, store, rules, [], projectGrants);
    const msg = notes[0]?.message ?? "";
    expect(msg).toMatch(/read: allowed by persistent project grant/);
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
    const file = join(piDir, "ward.id");
    await writeFile(file, "550e8400-e29b-41d4-a716-446655440000");
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

function projectIdFile(): string {
  return join(projectRoot, ".pi", "ward.id");
}

function grantsFileFor(id: string): string {
  return join(homeDir, ".pi", "agent", "ward", `${id}.grants.json`);
}

async function readProjectIdFile(): Promise<string | null> {
  try {
    return (await readFile(projectIdFile(), "utf-8")).trim();
  } catch {
    return null;
  }
}

type SelectImpl = (message: string, options: string[]) => string | undefined | Promise<string | undefined>;
type InputImpl = (title: string, placeholder?: string) => string | undefined | Promise<string | undefined>;

interface ProjectRunOpts {
  hasUI?: boolean;
  confirmResult?: boolean;
  selectResult?: string | undefined;
  selectSequence?: Array<string | undefined>;
  selectImpl?: SelectImpl;
  inputSequence?: Array<string | undefined>;
  inputImpl?: InputImpl;
  rules?: ParsedRule[];
  protectedIdentities?: ProtectedIdentity[];
  reloadPolicy?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

function makeProjectCtx(opts: ProjectRunOpts) {
  const notifications: Notification[] = [];
  const selectCalls: Array<{ message: string; options: string[] }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  let selectIdx = 0;
  let inputIdx = 0;
  return {
    notifications,
    selectCalls,
    confirmCalls,
    inputCalls,
    hasUI: opts.hasUI ?? true,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      select: async (message: string, options: string[]) => {
        selectCalls.push({ message, options });
        if (opts.selectImpl) return opts.selectImpl(message, options);
        if (opts.selectSequence) return opts.selectSequence[selectIdx++];
        return opts.selectResult;
      },
      confirm: async (title: string, message: string) => {
        confirmCalls.push({ title, message });
        return opts.confirmResult ?? true;
      },
      input: async (title: string, placeholder?: string) => {
        inputCalls.push({ title, placeholder });
        if (opts.inputImpl) return opts.inputImpl(title, placeholder);
        if (opts.inputSequence) return opts.inputSequence[inputIdx++];
        return undefined;
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

describe("/ward project allow (direct)", () => {
  it("persists an allow grant after confirmation, lazily creating ward.id, and reports success", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const reloadPolicy = vi.fn(async () => ({ ok: true as const }));

    const ctx = await runProject(`project allow ${file}`, { reloadPolicy });

    expect(ctx.notifications.at(-1)?.type).toBe("info");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Persisted read grant/);
    expect(ctx.notifications.at(-1)?.message).toMatch(/reloaded/i);
    expect(reloadPolicy).toHaveBeenCalledOnce();

    const id = await readProjectIdFile();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants).toHaveLength(1);
    expect(written.grants[0]).toMatchObject({ operations: "read" });
  });

  it("persists a write grant when 'write' is specified", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    await runProject(`project allow write ${file}`);

    const id = await readProjectIdFile();
    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants[0]).toMatchObject({ operations: "write" });
  });

  it("shows a concise exact preview and writes nothing when cancelled", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = await runProject(`project allow ${file}`, { confirmResult: false });

    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.confirmCalls[0]?.title).toBe("Add project grant?");
    const msg = ctx.confirmCalls[0]?.message ?? "";
    expect(msg).toMatch(/^read .*notes\.txt \(file\)\nscope: this project \(id: [0-9a-f]{8}\)$/);
    expect(ctx.notifications.at(-1)?.type).toBe("info");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Cancelled/);
    expect(await readProjectIdFile()).toBeNull();
  });

  it("previews the short existing project id without recreating it", async () => {
    await mkdir(join(projectRoot, ".pi"), { recursive: true });
    const existingId = "550e8400-e29b-41d4-a716-446655440000";
    await writeFile(projectIdFile(), existingId, "utf-8");

    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = await runProject(`project allow ${file}`, { confirmResult: false });

    const msg = ctx.confirmCalls[0]?.message ?? "";
    expect(msg).toContain(`scope: this project (id: ${existingId.slice(0, 8)})`);
    expect(await readProjectIdFile()).toBe(existingId);
  });

  it("refuses to persist without an interactive UI (headless)", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = await runProject(`project allow ${file}`, { hasUI: false });
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/interactive session/);
    expect(await readProjectIdFile()).toBeNull();
  });

  it("shows usage when no path is given", async () => {
    const ctx = await runProject("project allow");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Usage: \/ward project allow/);
  });

  it("rejects glob characters in path", async () => {
    const ctx = await runProject("project allow ~/foo/*.ts");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/glob/i);
  });

  it("rejects unresolvable paths (broken symlink)", async () => {
    const broken = join(outsideDir, "broken-project-link");
    await symlink(join(outsideDir, "nonexistent-target"), broken);

    const ctx = await runProject(`project allow ${broken}`);
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/cannot be resolved/i);
  });

  it("rejects a self-protected target", async () => {
    const protectedDir = join(outsideDir, ".pi");
    await mkdir(protectedDir, { recursive: true });
    const protectedFile = join(protectedDir, "ward.id");
    await writeFile(protectedFile, "550e8400-e29b-41d4-a716-446655440000");

    const ctx = await runProject(`project allow write ${protectedFile}`);
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/protected/i);
  });

  it("discloses (without blocking) an ordinary global deny rule it overrides", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    const globalDenyRule = makeRule("notes.txt", "deny", outsideDir);
    const reloadPolicy = vi.fn(async () => ({ ok: true as const }));

    const ctx = await runProject(`project allow ${file}`, { rules: [globalDenyRule], reloadPolicy });

    expect(ctx.confirmCalls[0]?.message).toMatch(/overrides: global deny "notes\.txt"/);
    expect(ctx.notifications.at(-1)?.type).toBe("info");
    const id = await readProjectIdFile();
    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants).toHaveLength(1);
  });

  it("rejects an exact duplicate persistent grant", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow ${file}`);

    const ctx = await runProject(`project allow ${file}`);
    expect(ctx.notifications.at(-1)?.type).toBe("warning");
    expect(ctx.notifications.at(-1)?.message).toMatch(/already granted/i);
  });

  it("rejects a target already covered by a broader existing directory grant", async () => {
    await runProject(`project allow write ${outsideDir}/`);
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");

    const ctx = await runProject(`project allow ${file}`);
    expect(ctx.notifications.at(-1)?.type).toBe("warning");
    expect(ctx.notifications.at(-1)?.message).toMatch(/broader existing persistent grant/i);
  });

  it("does not reject a new recursive directory grant when a file grant exists at the same resolved path", async () => {
    const target = join(outsideDir, "leaf");
    await writeFile(target, "hi");
    await runProject(`project allow ${target}`);

    // Simulate the path changing from a file to a directory (e.g. recreated as a dir).
    await rm(target);
    await mkdir(target);
    const inner = join(target, "child.txt");
    await writeFile(inner, "child");

    const reloadPolicy = vi.fn(async () => ({ ok: true as const }));
    const ctx = await runProject(`project allow write ${target}/`, { reloadPolicy });

    expect(ctx.notifications.at(-1)?.type).not.toBe("warning");
    const id = await readProjectIdFile();
    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants).toHaveLength(2);
  });

  it("reports a persistence success with a reload-failure fallback message", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const reloadPolicy = vi.fn(async () => ({ ok: false as const, reason: "boom" }));

    const ctx = await runProject(`project allow ${file}`, { reloadPolicy });

    expect(ctx.notifications.at(-1)?.type).toBe("warning");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Persisted read grant/);
    expect(ctx.notifications.at(-1)?.message).toMatch(/boom/);
    expect(ctx.notifications.at(-1)?.message).toMatch(/restart to apply/);

    const id = await readProjectIdFile();
    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants).toHaveLength(1);
  });

  it("reports a warning and writes nothing when confirm throws", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");

    const ctx = makeProjectCtx({});
    ctx.ui.confirm = vi.fn(async () => {
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
    expect(await readProjectIdFile()).toBeNull();
  });
});

describe("/ward project revoke (direct)", () => {
  it("removes a persistent grant after confirmation and reports success", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow ${file}`);
    const reloadPolicy = vi.fn(async () => ({ ok: true as const }));

    const ctx = await runProject(`project revoke ${file}`, { reloadPolicy });

    expect(ctx.notifications.at(-1)?.type).toBe("info");
    expect(ctx.notifications.at(-1)?.message).toMatch(/Revoked persistent grant/);
    expect(reloadPolicy).toHaveBeenCalledOnce();
  });

  it("deletes the grants file (retaining ward.id) when revoking the final grant", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow ${file}`);
    const id = await readProjectIdFile();

    await runProject(`project revoke ${file}`);

    await expect(readFile(grantsFileFor(id as string), "utf-8")).rejects.toThrow();
    expect(await readProjectIdFile()).toBe(id);
  });

  it("keeps remaining grants when revoking one of several", async () => {
    const file1 = join(outsideDir, "a.txt");
    const file2 = join(outsideDir, "b.txt");
    await writeFile(file1, "1");
    await writeFile(file2, "2");
    await runProject(`project allow ${file1}`);
    await runProject(`project allow ${file2}`);
    const id = await readProjectIdFile();

    await runProject(`project revoke ${file1}`);

    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants).toHaveLength(1);
  });

  it("shows a preview and writes nothing when cancelled", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow ${file}`);
    const id = await readProjectIdFile();

    const ctx = await runProject(`project revoke ${file}`, { confirmResult: false });

    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.notifications.at(-1)?.message).toMatch(/Cancelled/);
    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants).toHaveLength(1);
  });

  it("reports no grant found when nothing matches", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");

    const ctx = await runProject(`project revoke ${file}`);
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/No persistent project grant found/);
  });

  it("shows usage when no path given", async () => {
    const ctx = await runProject("project revoke");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Usage: \/ward project revoke/);
  });

  it("reports an accurate message and writes nothing when ward.id is malformed", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await mkdir(join(projectRoot, ".pi"), { recursive: true });
    await writeFile(projectIdFile(), "not-a-uuid", "utf-8");

    const ctx = await runProject(`project revoke ${file}`);

    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/^Cannot read project grant state:/);
    expect(await readFile(projectIdFile(), "utf-8")).toBe("not-a-uuid");
  });

  it("refuses without an interactive UI (headless)", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow ${file}`);

    const ctx = await runProject(`project revoke ${file}`, { hasUI: false });
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/interactive session/);
  });
});

describe("/ward project list", () => {
  it("reports none when there are no persistent grants", async () => {
    const ctx = await runProject("project list");
    expect(ctx.notifications[0]?.type).toBe("info");
    expect(ctx.notifications[0]?.message).toMatch(/No persistent grants/);
  });

  it("lists operation/path/file-or-directory for existing grants, read-only", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow write ${file}`);

    const ctx = await runProject("project list");
    const msg = ctx.notifications[0]?.message ?? "";
    expect(msg).toMatch(/allow write/);
    expect(msg).toMatch(/notes\.txt/);
    expect(msg).toMatch(/\(file\)/);
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  it("works headless (read-only)", async () => {
    const ctx = await runProject("project list", { hasUI: false });
    expect(ctx.notifications[0]?.type).toBe("info");
  });
});

describe("/ward project unknown subcommand", () => {
  it("shows project usage for an unrecognised subcommand", async () => {
    const ctx = await runProject("project bogus");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/Usage: \/ward project/);
  });
});

describe("/ward project deny (unsupported)", () => {
  it("reports deny is unsupported with clear usage, without touching the UI", async () => {
    const ctx = await runProject("project deny read ~/foo");
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/not supported/i);
    expect(ctx.notifications[0]?.message).toMatch(/allow-only/i);
    expect(ctx.confirmCalls).toHaveLength(0);
  });
});

describe("/ward project (no-arg manager)", () => {
  it("closes immediately without any changes", async () => {
    const ctx = await runProject("project", { selectSequence: ["Close"] });
    expect(ctx.confirmCalls).toHaveLength(0);
    expect(await readProjectIdFile()).toBeNull();
  });

  it("adds a grant via Add -> operation -> path, then Close", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");

    const ctx = await runProject("project", {
      selectSequence: ["Add", "read", "Close"],
      inputSequence: [file],
    });

    expect(ctx.notifications.at(-1)?.message).toMatch(/Persisted read grant/);
    const id = await readProjectIdFile();
    const written = JSON.parse(await readFile(grantsFileFor(id as string), "utf-8"));
    expect(written.grants).toHaveLength(1);
  });

  it("returns to the menu when Add is cancelled (no path entered)", async () => {
    const ctx = await runProject("project", {
      selectSequence: ["Add", "read", "Close"],
      inputSequence: [undefined],
    });
    expect(ctx.notifications).toHaveLength(0);
    expect(await readProjectIdFile()).toBeNull();
  });

  it("revokes a grant via Revoke -> select -> confirm, then Close", async () => {
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow ${file}`);
    const id = await readProjectIdFile();

    let step = 0;
    const ctx = await runProject("project", {
      selectImpl: (_message, options) => {
        step++;
        if (step === 1) return "Revoke";
        if (step === 2) return options[0];
        return "Close";
      },
    });

    expect(ctx.notifications.at(-1)?.message).toMatch(/Revoked persistent grant/);
    await expect(readFile(grantsFileFor(id as string), "utf-8")).rejects.toThrow();
  });

  it("resolves the selected revoke option by numbered index, not by ambiguous label text", async () => {
    // Two entries with identical path/operations format to identical label
    // text; the manager must still map the user's selection back to the
    // right array slot via the numbered prefix instead of `indexOf(label)`.
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hi");
    await runProject(`project allow ${file}`);
    const id = await readProjectIdFile();
    const grantsPath = grantsFileFor(id as string);
    const before = JSON.parse(await readFile(grantsPath, "utf-8"));
    await writeFile(grantsPath, JSON.stringify({ grants: [before.grants[0], before.grants[0]] }), "utf-8");

    let step = 0;
    let capturedRevokeOptions: string[] = [];
    const ctx = await runProject("project", {
      selectImpl: (_message, options) => {
        step++;
        if (step === 1) return "Revoke";
        if (step === 2) {
          capturedRevokeOptions = options;
          expect(options[0]).not.toBe(options[1]); // numbered prefixes make them distinct
          expect(options[0]?.replace(/^\d+\. /, "")).toBe(options[1]?.replace(/^\d+\. /, ""));
          return options[1];
        }
        return "Close";
      },
    });

    expect(capturedRevokeOptions).toHaveLength(2);
    expect(ctx.notifications.at(-1)?.message).toMatch(/Revoked persistent grant/);
    await expect(readFile(grantsPath, "utf-8")).rejects.toThrow();
  });

  it("refuses without full interactive UI support", async () => {
    const ctx = await runProject("project", { hasUI: false });
    expect(ctx.notifications[0]?.type).toBe("warning");
    expect(ctx.notifications[0]?.message).toMatch(/interactive session/);
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

// ---------------------------------------------------------------------------
// startupError (fail-closed startup)
// ---------------------------------------------------------------------------

describe("startupError", () => {
  it("refuses every subcommand and reports repair/reload required, without mutating or reporting normal policy", async () => {
    const store = new GrantStore();
    const file = join(outsideDir, "notes.txt");
    await writeFile(file, "hello");
    const ctx = makeCtx();

    await wardCommandHandler(`allow ${file}`, ctx, {
      rules: [],
      projectRoot,
      homeDir,
      grants: store,
      startupError: "Cannot read config file: boom",
    });

    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0]?.type).toBe("error");
    expect(ctx.notifications[0]?.message).toMatch(/boom/);
    expect(ctx.notifications[0]?.message).toMatch(/reload.*restart/);
    // No grant was recorded — the command was refused outright.
    expect(store.listAllows()).toHaveLength(0);
  });

  it("also refuses read-only subcommands like status/list", async () => {
    const store = new GrantStore();
    const ctx = makeCtx();

    await wardCommandHandler("list", ctx, {
      rules: [],
      projectRoot,
      homeDir,
      grants: store,
      startupError: "malformed ward.id",
    });

    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0]?.type).toBe("error");
    expect(ctx.notifications[0]?.message).not.toMatch(/No active session grants/);
  });
});
