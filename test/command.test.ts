import { link, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wardCommandHandler } from "../src/command.js";
import { GrantStore } from "../src/grants.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";
import type { ProtectedIdentity } from "../src/self-protect.js";

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
