import { globalConfigPath } from "./config.js";
import { evaluate } from "./evaluator.js";
import { isDirectory } from "./fs-utils.js";
import type { GrantStore } from "./grants.js";
import type { PreparedCandidate } from "./project-policy.js";
import { listProjectRules, persistCandidate, preflightCandidate, prepareCandidate } from "./project-policy.js";
import { resolvePath } from "./resolve.js";
import type { Effect, Operation, ParsedRule } from "./rules.js";
import type { ProtectedIdentity } from "./self-protect.js";
import { isSelfProtected } from "./self-protect.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select?(message: string, options: string[]): Promise<string | undefined>;
  };
  hasUI?: boolean;
}

export interface WardCommandDeps {
  rules: ParsedRule[];
  projectRoot: string;
  homeDir: string;
  grants: GrantStore;
  protectedIdentities?: ProtectedIdentity[];
  /**
   * Reload the complete global+project policy into the caller's live
   * closure after a successful persistent write. Returns `{ ok: false }`
   * (without throwing) when the reload itself fails — the caller should
   * report that disk persistence succeeded but immediate enforcement did
   * not pick up the change.
   */
  reloadPolicy?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
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

  if (operation === "write" && (await isSelfProtected(resolved.nominalPath, resolved.path, deps.protectedIdentities))) {
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
// Subcommand: project
// ---------------------------------------------------------------------------

const PROJECT_USAGE =
  "Usage: /ward project <allow|deny|list>\n" +
  "  allow [read|write] <path>  \u2014 persist an allow rule scoped to this project (requires confirmation)\n" +
  "  deny [read|write] <path>   \u2014 persist a deny rule scoped to this project (requires confirmation)\n" +
  "  list                       \u2014 show persisted rules scoped to this project";

async function handleProjectMutation(
  effect: Effect,
  rest: string,
  deps: WardCommandDeps,
  ctx: CommandContext,
): Promise<void> {
  const { operation, rawPath } = parseOperationAndPath(rest);

  if (!rawPath) {
    ctx.ui.notify(`Usage: /ward project ${effect} [read|write] <path>`, "warning");
    return;
  }

  if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
    ctx.ui.notify(
      "Persisting project policy rules requires an interactive session with confirmation support.",
      "warning",
    );
    return;
  }

  let candidate: PreparedCandidate;
  try {
    candidate = await prepareCandidate({
      rawPath,
      effect,
      operation,
      projectRoot: deps.projectRoot,
      homeDir: deps.homeDir,
      protectedIdentities: deps.protectedIdentities,
    });
  } catch (err) {
    ctx.ui.notify((err as Error).message, "warning");
    return;
  }

  const projectRules = deps.rules.filter((r) => r.configDir === deps.projectRoot);

  let snapshot: Awaited<ReturnType<typeof preflightCandidate>>["snapshot"];
  let result: Awaited<ReturnType<typeof preflightCandidate>>["result"];
  try {
    ({ snapshot, result } = await preflightCandidate(candidate, projectRules, deps.homeDir));
  } catch (err) {
    ctx.ui.notify(`Cannot read existing policy config: ${(err as Error).message}`, "warning");
    return;
  }
  if (!result.ok) {
    ctx.ui.notify(result.reason, "warning");
    return;
  }

  const previewLines: string[] = [
    `effect: ${candidate.effect}`,
    `operation: ${candidate.operations}`,
    `pattern: ${candidate.pattern}`,
    `projectRoot condition: ${candidate.rule.projectRoot}`,
    `destination: ${globalConfigPath()}`,
  ];
  if (result.supersedes) {
    previewLines.push(
      `note: this deny would supersede an existing project rule "${result.supersedes.pattern}" ` +
        `(effect ${result.supersedes.effect}, from ${result.supersedes.configDir})`,
    );
  }

  let selection: string | undefined;
  try {
    selection = await ctx.ui.select(`Persist ward policy change?\n\n${previewLines.join("\n")}`, ["Cancel", "Persist"]);
  } catch (err) {
    ctx.ui.notify(`Confirmation failed: ${(err as Error).message} \u2014 no changes written.`, "warning");
    return;
  }
  if (selection !== "Persist") {
    ctx.ui.notify("Cancelled \u2014 no changes written.", "info");
    return;
  }

  const persistResult = await persistCandidate({
    candidate,
    previousRaw: snapshot.raw,
    projectRules,
    homeDir: deps.homeDir,
  });

  if (!persistResult.ok) {
    ctx.ui.notify(`Failed to persist: ${persistResult.reason}`, "warning");
    return;
  }

  const reload = deps.reloadPolicy ? await deps.reloadPolicy() : { ok: false as const, reason: "reload not wired up" };
  if (reload.ok) {
    ctx.ui.notify(
      `Persisted ${candidate.effect} ${candidate.operations} rule for ${candidate.pattern}. Policy reloaded.`,
      "info",
    );
  } else {
    ctx.ui.notify(
      `Persisted ${candidate.effect} ${candidate.operations} rule for ${candidate.pattern}, but reloading the ` +
        `in-memory policy failed (${reload.reason}) \u2014 restart to apply it.`,
      "warning",
    );
  }
}

async function handleProjectList(deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  let rules: Awaited<ReturnType<typeof listProjectRules>>;
  try {
    rules = await listProjectRules(deps.projectRoot, deps.homeDir);
  } catch (err) {
    ctx.ui.notify(`Cannot read existing policy config: ${(err as Error).message}`, "warning");
    return;
  }

  if (rules.length === 0) {
    ctx.ui.notify("No persisted rules scoped to this project.", "info");
    return;
  }

  const lines: string[] = ["Persisted project rules:"];
  for (const r of rules) {
    lines.push(`  ${r.effect.padEnd(5)} ${r.operations.padEnd(5)} ${r.rawPattern}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleProject(rest: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const trimmed = rest.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const subRest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  switch (sub) {
    case "allow":
      await handleProjectMutation("allow", subRest, deps, ctx);
      break;
    case "deny":
      await handleProjectMutation("deny", subRest, deps, ctx);
      break;
    case "list":
      await handleProjectList(deps, ctx);
      break;
    default:
      ctx.ui.notify(PROJECT_USAGE, "warning");
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
    if (op === "write" && (await isSelfProtected(resolved.nominalPath, resolved.path, deps.protectedIdentities))) {
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
  "Usage: /ward <allow|deny|list|revoke|status|project>\n" +
  "  allow [read|write] <path>  — grant session access\n" +
  "  deny [read|write] <path>   — hard session block (overrides grants/rules); default read blocks read+write\n" +
  "  list                       — show active session grants/denies\n" +
  "  revoke <path>              — remove a grant/deny\n" +
  "  status <path>              — show what rules/grants apply to a path\n" +
  "  project <allow|deny|list>  — manage persisted project-scoped policy rules";

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
    case "project":
      await handleProject(rest, deps, ctx);
      break;
    default:
      ctx.ui.notify(USAGE, "warning");
  }
}
