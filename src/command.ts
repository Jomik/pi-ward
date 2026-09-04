import { evaluate } from "./evaluator.js";
import { isDirectory } from "./fs-utils.js";
import type { GrantStore } from "./grants.js";
import { resolvePath } from "./resolve.js";
import type { Operation, ParsedRule } from "./rules.js";
import { isSelfProtected } from "./self-protect.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface WardCommandDeps {
  rules: ParsedRule[];
  projectRoot: string;
  homeDir: string;
  grants: GrantStore;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reformat an absolute path back to `~/…` form for display. */
function displayPath(absolutePath: string, homeDir: string): string {
  if (absolutePath === homeDir) return "~";
  if (absolutePath.startsWith(`${homeDir}/`)) return `~${absolutePath.slice(homeDir.length)}`;
  return absolutePath;
}

/** Returns true if the input path contains glob/wildcard characters. */
function containsGlob(inputPath: string): boolean {
  return /[*?]|\[|\]/.test(inputPath);
}

/**
 * Parse an optional leading `read|write` operation token from `rest`,
 * preserving any internal whitespace (e.g. repeated spaces) in the
 * remaining literal path.
 */
function parseOperationAndPath(rest: string): { operation: Operation; rawPath: string } {
  const trimmed = rest.trim();
  const match = trimmed.match(/^(read|write)(?:\s+([\s\S]*))?$/);
  if (match) {
    return { operation: match[1] as Operation, rawPath: match[2] ?? "" };
  }
  return { operation: "read", rawPath: trimmed };
}

// ---------------------------------------------------------------------------
// Subcommand: allow
// ---------------------------------------------------------------------------

async function handleAllow(rest: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const { operation, rawPath } = parseOperationAndPath(rest);

  if (!rawPath) {
    ctx.ui.notify("Usage: /ward allow [read|write] <path>", "warning");
    return;
  }

  if (containsGlob(rawPath)) {
    ctx.ui.notify("Glob patterns are not supported — use literal paths only", "warning");
    return;
  }

  // Detect trailing slash BEFORE path resolution strips it.
  const trailingSlash = rawPath.endsWith("/");
  const resolved = await resolvePath(rawPath, deps.projectRoot, deps.homeDir);

  if (resolved.denied) {
    ctx.ui.notify(`Cannot resolve path: ${resolved.denied}`, "warning");
    return;
  }

  // Only baseline denies are grantable; reject explicit rule denies.
  const evalResult = evaluate(deps.rules, operation, resolved.path, deps.projectRoot);
  if (evalResult.effect === "deny" && evalResult.source === "rule") {
    ctx.ui.notify(`Cannot grant: ${rawPath} is denied by an explicit policy rule`, "warning");
    return;
  }

  if (operation === "write" && isSelfProtected(resolved.path)) {
    ctx.ui.notify(`Cannot grant write: ${rawPath} is a ward config file (write-protected)`, "warning");
    return;
  }

  const dir = trailingSlash || (await isDirectory(resolved.path));
  deps.grants.addAllow(resolved.path, operation, dir);

  const label = displayPath(resolved.path, deps.homeDir) + (dir ? "/" : "");
  ctx.ui.notify(`Granted ${operation} access to ${label}${dir ? " (directory)" : " (file)"}`, "info");
}

// ---------------------------------------------------------------------------
// Subcommand: deny
// ---------------------------------------------------------------------------

async function handleDeny(rest: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const { operation, rawPath } = parseOperationAndPath(rest);

  if (!rawPath) {
    ctx.ui.notify("Usage: /ward deny [read|write] <path>", "warning");
    return;
  }

  if (containsGlob(rawPath)) {
    ctx.ui.notify("Glob patterns are not supported — use literal paths only", "warning");
    return;
  }

  const trailingSlash = rawPath.endsWith("/");
  const resolved = await resolvePath(rawPath, deps.projectRoot, deps.homeDir);

  if (resolved.denied) {
    ctx.ui.notify(`Cannot resolve path: ${resolved.denied}`, "warning");
    return;
  }

  // Session denies are always stored — they're a hard temporary block that
  // overrides rule allows, baseline allows, session grants, and call-scoped
  // approvals (see checkPath). No rule/baseline evaluation is needed here.
  const dir = trailingSlash || (await isDirectory(resolved.path));
  deps.grants.addDeny(resolved.path, operation, dir);

  const label = displayPath(resolved.path, deps.homeDir) + (dir ? "/" : "");
  ctx.ui.notify(`Denied ${operation} access to ${label}${dir ? " (directory)" : " (file)"}`, "info");
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

function handleList(deps: WardCommandDeps, ctx: CommandContext): void {
  const allows = deps.grants.listAllows();
  const denies = deps.grants.listDenies();

  if (allows.length === 0 && denies.length === 0) {
    ctx.ui.notify("No active session grants or denies.", "info");
    return;
  }

  const lines: string[] = ["Session decisions:"];

  for (const d of allows) {
    const label = displayPath(d.path, deps.homeDir) + (d.directory ? "/" : "");
    const type = d.directory ? "(directory)" : "(file)";
    lines.push(`  allow ${d.operation.padEnd(5)} ${label.padEnd(32)} ${type}`);
  }

  for (const d of denies) {
    const label = displayPath(d.path, deps.homeDir) + (d.directory ? "/" : "");
    const type = d.directory ? "(directory)" : "(file)";
    lines.push(`  deny  ${d.operation.padEnd(5)} ${label.padEnd(32)} ${type}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Subcommand: revoke
// ---------------------------------------------------------------------------

async function handleRevoke(rest: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const rawPath = rest.trim();
  if (!rawPath) {
    ctx.ui.notify("Usage: /ward revoke <path>", "warning");
    return;
  }

  if (containsGlob(rawPath)) {
    ctx.ui.notify("Glob patterns are not supported — use literal paths only", "warning");
    return;
  }

  const resolved = await resolvePath(rawPath, deps.projectRoot, deps.homeDir);

  if (resolved.denied) {
    ctx.ui.notify(`Cannot resolve path: ${resolved.denied}`, "warning");
    return;
  }

  const label = displayPath(resolved.path, deps.homeDir);
  const removed = deps.grants.revoke(resolved.path);
  if (removed) {
    ctx.ui.notify(`Revoked session grant/deny for ${label}`, "info");
  } else {
    ctx.ui.notify(`No active session grant or deny found for ${label}`, "warning");
  }
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

async function handleStatus(rest: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const rawPath = rest.trim();
  if (!rawPath) {
    ctx.ui.notify("Usage: /ward status <path>", "warning");
    return;
  }

  if (containsGlob(rawPath)) {
    ctx.ui.notify("Glob patterns are not supported — use literal paths only", "warning");
    return;
  }

  const resolved = await resolvePath(rawPath, deps.projectRoot, deps.homeDir);

  if (resolved.denied) {
    ctx.ui.notify(`Cannot resolve path: ${resolved.denied}`, "warning");
    return;
  }

  const lines: string[] = [`Status for ${rawPath}`, `  resolved: ${resolved.path}`];

  for (const op of ["read", "write"] as Operation[]) {
    // Self-protection check for write operations takes top precedence.
    if (op === "write" && isSelfProtected(resolved.path)) {
      lines.push(`  write: denied (ward config file — write-protected)`);
      continue;
    }

    // A session deny is a hard temporary block that overrides rule allows
    // and baseline allows — check it before evaluating rules/baseline.
    if (deps.grants.isDenied(resolved.path, op)) {
      lines.push(`  ${op}: denied by session deny`);
      continue;
    }

    const evalResult = evaluate(deps.rules, op, resolved.path, deps.projectRoot);

    if (evalResult.effect === "allow" && evalResult.source === "rule") {
      lines.push(`  ${op}: allowed by rule: pattern "${evalResult.pattern}" (from ${evalResult.configDir})`);
    } else if (evalResult.effect === "allow" && evalResult.source === "baseline") {
      lines.push(`  ${op}: allowed by baseline (inside project root)`);
    } else if (evalResult.effect === "deny" && evalResult.source === "rule") {
      lines.push(
        `  ${op}: denied by rule: pattern "${evalResult.pattern}" (from ${evalResult.configDir}) — not grantable`,
      );
    } else if (deps.grants.isAllowed(resolved.path, op)) {
      lines.push(`  ${op}: allowed by session grant`);
    } else {
      lines.push(`  ${op}: denied by baseline (outside project root) — grantable`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: /ward <allow|deny|list|revoke|status>\n" +
  "  allow [read|write] <path>  — grant session access\n" +
  "  deny [read|write] <path>   — hard session block (overrides grants/rules); default read blocks read+write\n" +
  "  list                       — show active session grants/denies\n" +
  "  revoke <path>              — remove a grant/deny\n" +
  "  status <path>              — show what rules/grants apply to a path";

export async function wardCommandHandler(args: string, ctx: CommandContext, deps: WardCommandDeps): Promise<void> {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const subcommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  switch (subcommand) {
    case "allow":
      await handleAllow(rest, deps, ctx);
      break;
    case "deny":
      await handleDeny(rest, deps, ctx);
      break;
    case "list":
      handleList(deps, ctx);
      break;
    case "revoke":
      await handleRevoke(rest, deps, ctx);
      break;
    case "status":
      await handleStatus(rest, deps, ctx);
      break;
    default:
      ctx.ui.notify(USAGE, "warning");
  }
}
