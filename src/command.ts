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
  protectedPaths: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~/` (or bare `~`) using the resolved home directory. */
function expandHome(inputPath: string, homeDir: string): string {
  if (inputPath === "~") return homeDir;
  if (inputPath.startsWith("~/")) return homeDir + inputPath.slice(1);
  return inputPath;
}

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

// ---------------------------------------------------------------------------
// Subcommand: allow
// ---------------------------------------------------------------------------

async function handleAllow(rest: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const parts = rest.trim().split(/\s+/);

  let operation: Operation = "read";
  let rawPath: string;

  if (parts[0] === "read" || parts[0] === "write") {
    operation = parts[0] as Operation;
    rawPath = parts.slice(1).join(" ");
  } else {
    rawPath = parts.join(" ");
  }

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
  const expanded = expandHome(rawPath, deps.homeDir);
  const resolved = await resolvePath(expanded, deps.projectRoot);

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

  if (operation === "write" && isSelfProtected(resolved.path, deps.protectedPaths)) {
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
  const rawPath = rest.trim();
  if (!rawPath) {
    ctx.ui.notify("Usage: /ward deny <path>", "warning");
    return;
  }

  if (containsGlob(rawPath)) {
    ctx.ui.notify("Glob patterns are not supported — use literal paths only", "warning");
    return;
  }

  const trailingSlash = rawPath.endsWith("/");
  const expanded = expandHome(rawPath, deps.homeDir);
  const resolved = await resolvePath(expanded, deps.projectRoot);

  if (resolved.denied) {
    ctx.ui.notify(`Cannot resolve path: ${resolved.denied}`, "warning");
    return;
  }

  // Session denies only matter for baseline-denied operations. Check both read and write —
  // only warn if neither operation would hit a baseline deny.
  const readEval = evaluate(deps.rules, "read", resolved.path, deps.projectRoot);
  const writeEval = evaluate(deps.rules, "write", resolved.path, deps.projectRoot);
  const readBaselineDenied = readEval.effect === "deny" && readEval.source === "baseline";
  const writeBaselineDenied = writeEval.effect === "deny" && writeEval.source === "baseline";

  if (!readBaselineDenied && !writeBaselineDenied) {
    let reason: string;
    if (readEval.effect === "deny" || writeEval.effect === "deny") {
      reason = "denied by explicit rule — session deny is redundant";
    } else if (readEval.source === "rule" || writeEval.source === "rule") {
      reason = "allowed by rule";
    } else {
      reason = "inside project root";
    }
    ctx.ui.notify(
      `Warning: ${displayPath(resolved.path, deps.homeDir)} is ${reason} — session deny will have no effect`,
      "warning",
    );
    return;
  }

  const dir = trailingSlash || (await isDirectory(resolved.path));
  // Use operation "read" so the deny covers both read and write (deny+read → blocks all).
  deps.grants.addDeny(resolved.path, "read", dir);

  const label = displayPath(resolved.path, deps.homeDir) + (dir ? "/" : "");
  ctx.ui.notify(`Denied access to ${label}${dir ? " (directory)" : " (file)"}`, "info");
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

  const lines: string[] = ["Session grants:"];

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

  const expanded = expandHome(rawPath, deps.homeDir);
  const resolved = await resolvePath(expanded, deps.projectRoot);

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

  const expanded = expandHome(rawPath, deps.homeDir);
  const resolved = await resolvePath(expanded, deps.projectRoot);

  if (resolved.denied) {
    ctx.ui.notify(`Cannot resolve path: ${resolved.denied}`, "warning");
    return;
  }

  const lines: string[] = [`Status for ${rawPath}`, `  resolved: ${resolved.path}`];

  for (const op of ["read", "write"] as Operation[]) {
    const evalResult = evaluate(deps.rules, op, resolved.path, deps.projectRoot);

    // Self-protection check for write operations.
    if (op === "write" && isSelfProtected(resolved.path, deps.protectedPaths)) {
      lines.push(`  write: denied (ward config file — write-protected)`);
      continue;
    }

    if (evalResult.effect === "allow" && evalResult.source === "rule") {
      lines.push(`  ${op}: allowed by rule: pattern "${evalResult.pattern}" (from ${evalResult.configDir})`);
    } else if (evalResult.effect === "allow" && evalResult.source === "baseline") {
      lines.push(`  ${op}: allowed by baseline (inside project root)`);
    } else if (evalResult.effect === "deny" && evalResult.source === "rule") {
      lines.push(
        `  ${op}: denied by rule: pattern "${evalResult.pattern}" (from ${evalResult.configDir}) — not grantable`,
      );
    } else {
      // Baseline deny — check session grants/denies.
      if (deps.grants.isAllowed(resolved.path, op)) {
        lines.push(`  ${op}: allowed by session grant`);
      } else if (deps.grants.isDenied(resolved.path, op)) {
        lines.push(`  ${op}: denied by session deny`);
      } else {
        lines.push(`  ${op}: denied by baseline (outside project root) — grantable`);
      }
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
  "  deny <path>                — preemptively deny session access\n" +
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
