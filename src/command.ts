import { evaluate, operationCovers } from "./evaluator.js";
import { isDirectory } from "./fs-utils.js";
import type { GrantStore } from "./grants.js";
import { matchesProjectGrants } from "./grants.js";
import type { Grant, ParsedGrant } from "./project-grants.js";
import {
  createProjectId,
  deleteGrantsFile,
  generateProjectId,
  loadProjectGrantState,
  persistGrantsFile,
  prepareGrantInput,
} from "./project-grants.js";
import { resolvePath } from "./resolve.js";
import type { Operation, ParsedRule } from "./rules.js";
import type { ProtectedIdentity } from "./self-protect.js";
import { isSelfProtected } from "./self-protect.js";
import { isDescendantOf } from "./walk.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select?(message: string, options: string[]): Promise<string | undefined>;
    confirm?(title: string, message: string): Promise<boolean>;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
  };
  hasUI?: boolean;
}

export interface WardCommandDeps {
  rules: ParsedRule[];
  projectRoot: string;
  homeDir: string;
  grants: GrantStore;
  protectedIdentities?: ProtectedIdentity[];
  /** The active project's persistent grants, checked after session denies, before global rule evaluation. */
  projectGrants?: ParsedGrant[];
  /**
   * Reload the complete global+project policy into the caller's live
   * closure after a successful persistent write. Returns `{ ok: false }`
   * (without throwing) when the reload itself fails — the caller should
   * report that disk persistence succeeded but immediate enforcement did
   * not pick up the change.
   */
  reloadPolicy?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Set when the initial global policy/project grants load failed at
   * startup. While set, every `/ward` subcommand is refused — mutating
   * (allow/deny/revoke/project) or reporting (list/status) against a policy
   * that never actually loaded would be misleading. Report requires repair
   * of the underlying config plus a reload/restart.
   */
  startupError?: string;
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

  if (await isSelfProtected(resolved.nominalPath, resolved.path, operation, deps.protectedIdentities)) {
    ctx.ui.notify(`Cannot grant ${operation}: ${rawPath} is a ward config file (${operation}-protected)`, "warning");
    return;
  }

  const dir = trailingSlash || (await isDirectory(resolved.path));
  deps.grants.addAllow(resolved.path, operation, dir, true);

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
  "Usage: /ward project <allow|list|revoke>\n" +
  "  allow [read|write] <path>  \u2014 persist an allow grant scoped to this project (requires confirmation)\n" +
  "  list                       \u2014 show persistent grants scoped to this project\n" +
  "  revoke <path>              \u2014 remove a persistent grant scoped to this project (requires confirmation)\n" +
  "  (no args)                  \u2014 open the interactive project grant manager";

function hasConfirmUI(ctx: CommandContext): boolean {
  return !!ctx.hasUI && typeof ctx.ui.confirm === "function";
}

function hasFullProjectUI(ctx: CommandContext): boolean {
  return (
    !!ctx.hasUI &&
    typeof ctx.ui.select === "function" &&
    typeof ctx.ui.confirm === "function" &&
    typeof ctx.ui.input === "function"
  );
}

/** Format a single persistent grant for display (matches the style of `handleList`). */
function formatGrantLine(grant: ParsedGrant, homeDir: string): string {
  const label = displayPath(grant.resolvedPath, homeDir) + (grant.directory ? "/" : "");
  const type = grant.directory ? "(directory)" : "(file)";
  return `  allow ${grant.operations.padEnd(5)} ${label.padEnd(32)} ${type}`;
}

/**
 * Find an existing persistent grant that already covers `target` (same or
 * broader operation, and same path or an ancestor directory grant).
 */
function findCoveringGrant(existingGrants: ParsedGrant[], target: ParsedGrant): ParsedGrant | undefined {
  return existingGrants.find((g) => {
    if (!operationCovers("allow", g.operations, target.operations)) return false;
    if (g.directory) return isDescendantOf(g.resolvedPath, target.resolvedPath);
    return !target.directory && g.resolvedPath === target.resolvedPath;
  });
}

/**
 * Reload the live policy after a successful persistent write and report the
 * outcome — success (with reload status) or a reload-failure fallback.
 */
async function reportProjectPersisted(
  deps: WardCommandDeps,
  ctx: CommandContext,
  successMessage: string,
): Promise<void> {
  const reload = deps.reloadPolicy ? await deps.reloadPolicy() : { ok: false as const, reason: "reload not wired up" };
  if (reload.ok) {
    ctx.ui.notify(`${successMessage} Policy reloaded.`, "info");
  } else {
    ctx.ui.notify(
      `${successMessage} Reloading the in-memory policy failed (${reload.reason}) \u2014 restart to apply it.`,
      "warning",
    );
  }
}

/**
 * Add a persistent, allow-only project grant for `rawPath`/`operation`.
 *
 * Prepares and validates the candidate, rejects an exact duplicate or a
 * broader existing grant, discloses any ordinary global deny rule it would
 * override, and confirms the project scope before writing.
 * Generates a candidate id in memory for preview when the project has no
 * identity yet; the id file is only created after confirmation, and the
 * grants file is only written after that — an interrupted write may leave an
 * unused id, never a partial grant.
 */
async function handleProjectAdd(
  rawPath: string,
  operation: Operation,
  deps: WardCommandDeps,
  ctx: CommandContext,
): Promise<void> {
  if (!rawPath) {
    ctx.ui.notify("Usage: /ward project allow [read|write] <path>", "warning");
    return;
  }

  if (!hasConfirmUI(ctx)) {
    ctx.ui.notify(
      "Managing persistent project grants requires an interactive session with confirmation support.",
      "warning",
    );
    return;
  }

  let prepared: Awaited<ReturnType<typeof prepareGrantInput>>;
  try {
    prepared = await prepareGrantInput(rawPath, operation, deps.projectRoot, deps.homeDir, deps.protectedIdentities);
  } catch (err) {
    ctx.ui.notify((err as Error).message, "warning");
    return;
  }

  let state: Awaited<ReturnType<typeof loadProjectGrantState>>;
  try {
    state = await loadProjectGrantState(deps.projectRoot, deps.homeDir);
  } catch (err) {
    ctx.ui.notify(`Cannot read existing project grants: ${(err as Error).message}`, "warning");
    return;
  }
  const existingId = state.id;
  const existingGrants = state.grants;

  const exactDuplicate = existingGrants.find(
    (g) =>
      g.resolvedPath === prepared.parsed.resolvedPath &&
      g.directory === prepared.parsed.directory &&
      g.operations === prepared.parsed.operations,
  );
  if (exactDuplicate) {
    ctx.ui.notify("Already granted: an identical persistent grant already exists for this path.", "warning");
    return;
  }

  const covering = findCoveringGrant(existingGrants, prepared.parsed);
  if (covering) {
    const coveringLabel = displayPath(covering.resolvedPath, deps.homeDir) + (covering.directory ? "/" : "");
    ctx.ui.notify(
      `Already covered by a broader existing persistent grant: ${covering.operations} ${coveringLabel}`,
      "warning",
    );
    return;
  }

  const evalResult = evaluate(deps.rules, operation, prepared.parsed.resolvedPath, deps.projectRoot);
  const overriddenDeny = evalResult.effect === "deny" && evalResult.source === "rule" ? evalResult : undefined;

  const idForPreview = existingId ?? generateProjectId();
  const previewLines = [
    `${operation} ${prepared.grant.path} (${prepared.parsed.directory ? "recursive" : "file"})`,
    `scope: this project (id: ${idForPreview.slice(0, 8)})`,
  ];
  if (overriddenDeny) previewLines.push(`overrides: global deny "${overriddenDeny.pattern}"`);

  let confirmed: boolean;
  try {
    confirmed = await (ctx.ui.confirm as NonNullable<CommandContext["ui"]["confirm"]>)(
      "Add project grant?",
      previewLines.join("\n"),
    );
  } catch (err) {
    ctx.ui.notify(`Confirmation failed: ${(err as Error).message} \u2014 no changes written.`, "warning");
    return;
  }
  if (!confirmed) {
    ctx.ui.notify("Cancelled \u2014 no changes written.", "info");
    return;
  }

  let id: string;
  try {
    id = existingId ?? (await createProjectId(deps.projectRoot, idForPreview));
  } catch (err) {
    ctx.ui.notify(`Failed to create project identity: ${(err as Error).message}`, "warning");
    return;
  }

  const persistResult = await persistGrantsFile({
    id,
    grantsFile: { grants: [...state.grantsFile.grants, prepared.grant] },
    previousRaw: state.raw,
    homeDir: deps.homeDir,
  });
  if (!persistResult.ok) {
    ctx.ui.notify(`Failed to persist grant: ${persistResult.reason}`, "warning");
    return;
  }

  await reportProjectPersisted(deps, ctx, `Persisted ${operation} grant for ${prepared.grant.path}.`);
}

/**
 * Revoke all persistent grants matching `resolvedTarget` exactly (a
 * canonical resolved path). If the removal empties the grants file, the
 * file is deleted (retaining `ward.id`) rather than persisted as `{ grants:
 * [] }`.
 */
async function handleProjectRevokeAt(
  resolvedTarget: string,
  deps: WardCommandDeps,
  ctx: CommandContext,
): Promise<void> {
  if (!hasConfirmUI(ctx)) {
    ctx.ui.notify(
      "Managing persistent project grants requires an interactive session with confirmation support.",
      "warning",
    );
    return;
  }

  const label = displayPath(resolvedTarget, deps.homeDir);

  let state: Awaited<ReturnType<typeof loadProjectGrantState>>;
  try {
    state = await loadProjectGrantState(deps.projectRoot, deps.homeDir);
  } catch (err) {
    ctx.ui.notify(`Cannot read project grant state: ${(err as Error).message}`, "warning");
    return;
  }
  const id = state.id;
  if (id === null) {
    ctx.ui.notify(`No persistent project grant found for ${label}.`, "warning");
    return;
  }

  const keep: Grant[] = [];
  const removed: Grant[] = [];
  for (let i = 0; i < state.grantsFile.grants.length; i++) {
    const raw = state.grantsFile.grants[i];
    const parsed = state.grants[i];
    if (parsed?.resolvedPath === resolvedTarget) {
      removed.push(raw);
    } else {
      keep.push(raw);
    }
  }

  if (removed.length === 0) {
    ctx.ui.notify(`No persistent project grant found for ${label}.`, "warning");
    return;
  }

  const previewLines = [`path: ${label}`, `removing: ${removed.map((g) => g.operations ?? "read").join(", ")}`];
  if (keep.length === 0) {
    previewLines.push("note: this is the last persistent grant \u2014 the grants file will be deleted.");
  }

  let confirmed: boolean;
  try {
    confirmed = await (ctx.ui.confirm as NonNullable<CommandContext["ui"]["confirm"]>)(
      "Revoke persistent project grant?",
      previewLines.join("\n"),
    );
  } catch (err) {
    ctx.ui.notify(`Confirmation failed: ${(err as Error).message} \u2014 no changes written.`, "warning");
    return;
  }
  if (!confirmed) {
    ctx.ui.notify("Cancelled \u2014 no changes written.", "info");
    return;
  }

  if (state.raw === null) {
    ctx.ui.notify("Cannot revoke: grants file unexpectedly missing.", "warning");
    return;
  }

  const persistResult =
    keep.length === 0
      ? await deleteGrantsFile({ id, previousRaw: state.raw })
      : await persistGrantsFile({ id, grantsFile: { grants: keep }, previousRaw: state.raw, homeDir: deps.homeDir });

  if (!persistResult.ok) {
    ctx.ui.notify(`Failed to revoke grant: ${persistResult.reason}`, "warning");
    return;
  }

  await reportProjectPersisted(deps, ctx, `Revoked persistent grant for ${label}.`);
}

async function handleProjectRevokeCommand(rawPath: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    ctx.ui.notify("Usage: /ward project revoke <path>", "warning");
    return;
  }
  if (containsGlob(trimmed)) {
    ctx.ui.notify("Glob patterns are not supported \u2014 use literal paths only", "warning");
    return;
  }
  if (!hasConfirmUI(ctx)) {
    ctx.ui.notify(
      "Managing persistent project grants requires an interactive session with confirmation support.",
      "warning",
    );
    return;
  }

  const resolved = await resolvePath(trimmed, deps.projectRoot, deps.homeDir);
  if (resolved.denied) {
    ctx.ui.notify(`Cannot resolve path: ${resolved.denied}`, "warning");
    return;
  }

  await handleProjectRevokeAt(resolved.path, deps, ctx);
}

async function handleProjectListCmd(deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  let grants: ParsedGrant[];
  try {
    grants = (await loadProjectGrantState(deps.projectRoot, deps.homeDir)).grants;
  } catch (err) {
    ctx.ui.notify(`Cannot read persistent project grants: ${(err as Error).message}`, "warning");
    return;
  }

  if (grants.length === 0) {
    ctx.ui.notify("No persistent grants for this project.", "info");
    return;
  }

  const lines: string[] = ["Persistent project grants:"];
  for (const g of grants) lines.push(formatGrantLine(g, deps.homeDir));
  ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Interactive project grant manager, opened by `/ward project` with no
 * arguments. Lists current persistent grants and lets the user Add, Revoke,
 * or Close, reusing the same `select`/`input`/`confirm` UI primitives as the
 * direct subcommands \u2014 no custom component.
 */
async function handleProjectManager(deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  if (!hasFullProjectUI(ctx)) {
    ctx.ui.notify("Managing persistent project grants requires an interactive session.", "warning");
    return;
  }
  const select = ctx.ui.select as NonNullable<CommandContext["ui"]["select"]>;
  const input = ctx.ui.input as NonNullable<CommandContext["ui"]["input"]>;

  for (;;) {
    let grants: ParsedGrant[];
    try {
      grants = (await loadProjectGrantState(deps.projectRoot, deps.homeDir)).grants;
    } catch (err) {
      ctx.ui.notify(`Cannot read persistent project grants: ${(err as Error).message}`, "warning");
      return;
    }

    const grantLabels = grants.map((g) => formatGrantLine(g, deps.homeDir));
    const listing = grants.length === 0 ? "No persistent grants for this project." : grantLabels.join("\n");
    // Prefix each revoke option with its 1-based index so selections map back
    // to a grant deterministically, even if two grants happen to format to
    // identical labels.
    const revokeOptions = grants.map((g, i) => `${i + 1}. ${formatGrantLine(g, deps.homeDir)}`);
    const options = ["Add", ...(grants.length > 0 ? ["Revoke"] : []), "Close"];

    let choice: string | undefined;
    try {
      choice = await select(`Persistent project grants:\n\n${listing}`, options);
    } catch (err) {
      ctx.ui.notify(`Failed: ${(err as Error).message}`, "warning");
      return;
    }

    if (choice === undefined || choice === "Close") return;

    if (choice === "Add") {
      let operation: string | undefined;
      try {
        operation = await select("Operation:", ["read", "write"]);
      } catch (err) {
        ctx.ui.notify(`Failed: ${(err as Error).message}`, "warning");
        return;
      }
      if (operation !== "read" && operation !== "write") continue;

      let path: string | undefined;
      try {
        path = await input("Path to grant:", "");
      } catch (err) {
        ctx.ui.notify(`Failed: ${(err as Error).message}`, "warning");
        return;
      }
      if (!path) continue;

      await handleProjectAdd(path, operation, deps, ctx);
      continue;
    }

    if (choice === "Revoke") {
      let target: string | undefined;
      try {
        target = await select("Select grant to revoke:", revokeOptions);
      } catch (err) {
        ctx.ui.notify(`Failed: ${(err as Error).message}`, "warning");
        return;
      }
      if (target === undefined) continue;
      const match = /^(\d+)\./.exec(target);
      const idx = match ? Number(match[1]) - 1 : -1;
      const grant = grants[idx];
      if (grant === undefined) continue;

      await handleProjectRevokeAt(grant.resolvedPath, deps, ctx);
    }
  }
}

async function handleProject(rest: string, deps: WardCommandDeps, ctx: CommandContext): Promise<void> {
  const trimmed = rest.trim();
  if (!trimmed) {
    await handleProjectManager(deps, ctx);
    return;
  }

  const spaceIdx = trimmed.indexOf(" ");
  const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const subRest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  switch (sub) {
    case "allow": {
      const { operation, rawPath } = parseOperationAndPath(subRest);
      await handleProjectAdd(rawPath, operation, deps, ctx);
      break;
    }
    case "list":
      await handleProjectListCmd(deps, ctx);
      break;
    case "revoke":
      await handleProjectRevokeCommand(subRest, deps, ctx);
      break;
    case "deny":
      ctx.ui.notify(
        "Persistent project denies are not supported \u2014 project grants are allow-only. Use /ward deny for a session-scoped deny.",
        "warning",
      );
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
    // Self-protection check takes top precedence (covers ward.id for both
    // operations, and config/grants files for writes only).
    if (await isSelfProtected(resolved.nominalPath, resolved.path, op, deps.protectedIdentities)) {
      lines.push(`  ${op}: denied (ward config file — ${op}-protected)`);
      continue;
    }

    // A session deny is a hard temporary block that overrides rule allows
    // and baseline allows — check it before evaluating rules/baseline.
    if (deps.grants.isDenied(resolved.path, op)) {
      lines.push(`  ${op}: denied by session deny`);
      continue;
    }

    // Persistent project grants and explicit /ward allows override global
    // rules and the baseline, matching checkPath's precedence.
    if (matchesProjectGrants(deps.projectGrants ?? [], resolved.path, op)) {
      lines.push(`  ${op}: allowed by persistent project grant`);
      continue;
    }

    if (deps.grants.isExplicitlyAllowed(resolved.path, op)) {
      lines.push(`  ${op}: allowed by session grant`);
      continue;
    }

    const evalResult = evaluate(deps.rules, op, resolved.path, deps.projectRoot);

    if (evalResult.effect === "allow" && evalResult.source === "rule") {
      lines.push(`  ${op}: allowed by rule: pattern "${evalResult.pattern}" (from ${evalResult.configDir})`);
    } else if (evalResult.effect === "allow" && evalResult.source === "baseline") {
      lines.push(`  ${op}: allowed by baseline (inside project root)`);
    } else if (evalResult.effect === "deny" && evalResult.source === "rule") {
      lines.push(
        `  ${op}: denied by rule: pattern "${evalResult.pattern}" (from ${evalResult.configDir}) — explicit /ward allow required (no interactive prompt)`,
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
  "  project [allow|list|revoke] — manage persistent, allow-only project grants";

export async function wardCommandHandler(args: string, ctx: CommandContext, deps: WardCommandDeps): Promise<void> {
  if (deps.startupError !== undefined) {
    ctx.ui.notify(
      `[pi-ward] Policy failed to load at startup (${deps.startupError}) \u2014 guarded file operations are blocked and /ward commands are disabled until this is fixed and the extension is reloaded/restarted.`,
      "error",
    );
    return;
  }

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
