import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionFactory, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { wardCommandHandler } from "./command.js";
import { globalConfigPath, identityFor, loadConfig } from "./config.js";
import { isDirectory } from "./fs-utils.js";
import { GrantStore } from "./grants.js";
import { filterGrepOutput } from "./grep-filter.js";
import { checkPath } from "./guard.js";
import type { ParsedGrant } from "./project-grants.js";
import { canonicalGrantsPath, loadProjectGrantState, projectIdPath, readProjectId } from "./project-grants.js";
import { checkPromptApproval } from "./prompt-approval.js";
import type { Operation, ParsedRule } from "./rules.js";
import type { ProtectedIdentity } from "./self-protect.js";
import { createDeleteTool } from "./tools/delete.js";
import { createMoveTool } from "./tools/move.js";

/** Mirrors AutocompleteItem from @earendil-works/pi-tui (not a direct project dependency). */
type AutocompleteItem = { value: string; label: string; description?: string };

/** Argument completions for the `/ward` command. */
export function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const spaceIdx = prefix.indexOf(" ");

  if (spaceIdx === -1) {
    // User is still typing the subcommand.
    const subcommands: AutocompleteItem[] = [
      { value: "allow", label: "allow", description: "Grant session access to a path" },
      { value: "deny", label: "deny", description: "Preemptively deny session access to a path" },
      { value: "list", label: "list", description: "Show active session grants and denies" },
      { value: "revoke", label: "revoke", description: "Remove a session grant or deny for a path" },
      { value: "status", label: "status", description: "Show what rules and grants apply to a path" },
      { value: "project", label: "project", description: "Manage persistent, allow-only project grants" },
    ];
    const filtered = subcommands.filter((item) => item.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }

  if (prefix.startsWith("allow ")) {
    const afterAllow = prefix.slice("allow ".length);
    const operations: AutocompleteItem[] = [
      { value: "allow read", label: "read", description: "Grant read access to a path" },
      { value: "allow write", label: "write", description: "Grant read and write access to a path" },
    ];
    const filtered = operations.filter((item) => item.label.startsWith(afterAllow));
    return filtered.length > 0 ? filtered : null;
  }

  if (prefix.startsWith("deny ")) {
    const afterDeny = prefix.slice("deny ".length);
    const operations: AutocompleteItem[] = [
      { value: "deny read", label: "read", description: "Deny read (and write) access to a path" },
      { value: "deny write", label: "write", description: "Deny write access to a path" },
    ];
    const filtered = operations.filter((item) => item.label.startsWith(afterDeny));
    return filtered.length > 0 ? filtered : null;
  }

  if (prefix.startsWith("project ")) {
    const afterProject = prefix.slice("project ".length);
    const projectSpaceIdx = afterProject.indexOf(" ");

    if (projectSpaceIdx === -1) {
      const subcommands: AutocompleteItem[] = [
        { value: "project allow", label: "allow", description: "Persist an allow grant for this project" },
        { value: "project list", label: "list", description: "List persistent grants for this project" },
        { value: "project revoke", label: "revoke", description: "Revoke a persistent grant for this project" },
      ];
      const filtered = subcommands.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    }

    const projectSub = afterProject.slice(0, projectSpaceIdx);
    if (projectSub === "allow") {
      const afterSub = afterProject.slice(projectSpaceIdx + 1);
      const operations: AutocompleteItem[] = [
        { value: "project allow read", label: "read", description: "Persist a read allow grant for this project" },
        {
          value: "project allow write",
          label: "write",
          description: "Persist a read+write allow grant for this project",
        },
      ];
      const filtered = operations.filter((item) => item.label.startsWith(afterSub));
      return filtered.length > 0 ? filtered : null;
    }
  }

  return null;
}

/**
 * Extract the guard operation and path list from a tool call event.
 *
 * Returns `{ operation, paths }` for tools that require access checks, or
 * `null` for tools that should be ignored (e.g. bash).
 */
export function extractAccess(
  event: ToolCallEvent,
  projectRoot: string,
): { operation: Operation; paths: string[] } | null {
  if (isToolCallEventType("read", event)) {
    return { operation: "read", paths: [event.input.path] };
  }
  if (isToolCallEventType("write", event)) {
    return { operation: "write", paths: [event.input.path] };
  }
  if (isToolCallEventType("edit", event)) {
    return { operation: "write", paths: [event.input.path] };
  }
  if (isToolCallEventType("grep", event)) {
    return { operation: "read", paths: [event.input.path ?? projectRoot] };
  }
  if (isToolCallEventType("find", event)) {
    return { operation: "read", paths: [event.input.path ?? projectRoot] };
  }
  if (isToolCallEventType("ls", event)) {
    return { operation: "read", paths: [event.input.path ?? projectRoot] };
  }
  if (isToolCallEventType<"delete", { path: string }>("delete", event)) {
    return { operation: "write", paths: [event.input.path] };
  }
  if (isToolCallEventType<"move", { source: string; destination: string }>("move", event)) {
    return { operation: "write", paths: [event.input.source, event.input.destination] };
  }
  return null;
}

/** Genuine (non-extension-originated) input sources that qualify as prompt approval context. */
const GENUINE_INPUT_SOURCES = new Set(["interactive", "rpc"]);

/**
 * Build a concise, tool-accurate summary of a guarded call for display in
 * the access-approval UI and the herdr blocked-status label. This is
 * display-only: it never feeds back into authorization checks or grants,
 * which continue to operate solely on `operation` and the resolved path.
 */
export function describeToolCall(event: ToolCallEvent, operation: Operation, inputPath: string): string {
  if (isToolCallEventType("find", event)) {
    return `find ${event.input.pattern} in ${inputPath}`;
  }
  if (isToolCallEventType("grep", event)) {
    return `grep ${event.input.pattern} in ${inputPath}`;
  }
  if (isToolCallEventType("ls", event)) {
    return `ls ${inputPath}`;
  }
  if (isToolCallEventType("edit", event)) {
    return `edit ${inputPath}`;
  }
  if (isToolCallEventType<"delete", { path: string }>("delete", event)) {
    return `delete ${inputPath}`;
  }
  if (isToolCallEventType<"move", { source: string; destination: string }>("move", event)) {
    return `move ${event.input.source} to ${event.input.destination}`;
  }
  return `${operation} ${inputPath}`;
}

export async function promptAccess(
  events: { emit(channel: string, data: unknown): void },
  ctx: { hasUI: boolean; ui: { select(msg: string, options: string[]): Promise<string | undefined> } },
  toolName: string,
  operation: Operation,
  inputPath: string,
  resolvedPath: string,
  grants: GrantStore,
  summary: string = `${operation} ${inputPath}`,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: outside project root`,
    };
  }

  events.emit("herdr:blocked", { active: true, label: `Ward approval: ${summary}` });
  try {
    const action = await ctx.ui.select(`Access outside project root:\n\n  ${summary}`, ["Deny", "Approve"]);

    if (!action) {
      return { block: true, reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: dismissed` };
    }

    if (action !== "Approve") {
      const scope = await ctx.ui.select("Deny scope:", ["Once", "For session"]);
      if (scope === "For session") {
        const dir = await isDirectory(resolvedPath);
        grants.addDeny(resolvedPath, "read", dir);
      }
      return { block: true, reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: denied by user` };
    }

    const dir = await isDirectory(resolvedPath);
    const canonicalParent = dirname(resolvedPath);
    // Name the canonical resolved path (and parent) explicitly in each scope
    // label, so a raw/symlinked input path that differs from `resolvedPath`
    // is visible to the user before the broader session grant is recorded.
    const scopeOptions = dir
      ? ["Once", `Allow ${resolvedPath} for session`]
      : ["Once", `Allow ${resolvedPath} for session`, `Allow ${canonicalParent} for session`];
    const scope = await ctx.ui.select("Approve scope:", scopeOptions);
    // Match by index into the exact option list just offered, not by
    // reconstructing/parsing the label string, since the resolved path is
    // interpolated into it.
    const scopeIndex = scope === undefined ? -1 : scopeOptions.indexOf(scope);

    if (scopeIndex === 1) {
      grants.addAllow(resolvedPath, operation, dir);
    } else if (scopeIndex === 2) {
      grants.addAllow(canonicalParent, operation, true);
    }

    return undefined;
  } finally {
    events.emit("herdr:blocked", { active: false });
  }
}

/**
 * Handle a `tool_call` event: run the existing `checkPath` guard for each
 * target path, and — only for an otherwise-grantable `read` denial — check
 * whether the latest genuine prompt approves the target before prompting
 * the user. An approval here allows silently: it is never added to the
 * `GrantStore`.
 */
export async function handleToolCall(
  event: ToolCallEvent,
  ctx: { hasUI: boolean; ui: { select(msg: string, options: string[]): Promise<string | undefined> } },
  events: { emit(channel: string, data: unknown): void },
  deps: {
    rules: ParsedRule[];
    projectRoot: string;
    homeDir: string;
    grants: GrantStore;
    latestPrompt: string | undefined;
    /**
     * Call-scoped recursive read context, keyed by `event.toolCallId`. When a
     * grep read targets a prompt-approved path — directory or single file —
     * its canonical resolved path is recorded here so the matching
     * `tool_result` filter pass can permit it (descendants too, for a
     * directory; a regular file has none). Callers must remove the entry once
     * that call's filtering is done (see index.ts factory) — it must never
     * leak into `GrantStore` or authorize other calls.
     */
    callContexts?: Map<string, string>;
    protectedIdentities?: ProtectedIdentity[];
    projectGrants?: ParsedGrant[];
    /**
     * Set when the initial (or a subsequent) global policy/project grants
     * load failed. Every guarded file operation is blocked with this
     * persistent error until the underlying config is fixed and the
     * extension is reloaded/restarted; non-file/unrecognized tools are
     * unaffected (they never reach this check, since `extractAccess`
     * returns `null` for them).
     */
    startupError?: string;
  },
): Promise<{ block?: boolean; reason?: string } | undefined> {
  try {
    const dispatch = extractAccess(event, deps.projectRoot);
    if (dispatch === null) {
      return undefined;
    }

    if (deps.startupError !== undefined) {
      return {
        block: true,
        reason: `[pi-ward] Blocked ${event.toolName}: ward policy failed to load at startup (${deps.startupError}) — fix the underlying config and reload/restart to restore normal enforcement.`,
      };
    }

    const { operation, paths } = dispatch;

    for (const inputPath of paths) {
      const result = await checkPath(
        event.toolName,
        inputPath,
        operation,
        deps.rules,
        deps.projectRoot,
        deps.grants,
        undefined,
        deps.protectedIdentities,
        deps.projectGrants,
      );
      if (result.allowed) continue;
      if (!result.grantable) return { block: true, reason: result.reason };

      if (operation === "read" && deps.latestPrompt !== undefined) {
        const promptApproval = await checkPromptApproval(deps.latestPrompt, inputPath, deps.projectRoot, deps.homeDir);
        if (promptApproval.approved) {
          if (event.toolName === "grep" && deps.callContexts !== undefined) {
            deps.callContexts.set(event.toolCallId, result.resolvedPath);
          }
          continue;
        }
      }

      const blocked = await promptAccess(
        events,
        ctx,
        event.toolName,
        operation,
        inputPath,
        result.resolvedPath,
        deps.grants,
        describeToolCall(event, operation, inputPath),
      );
      if (blocked) return blocked;
    }

    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      block: true,
      reason: `[pi-ward] Internal error — access denied (fail-closed): ${message}`,
    };
  }
}

/**
 * Handle a `tool_result` event for the `grep` tool: filter output through
 * `filterGrepOutput`, using the call-scoped approved root (if any) recorded
 * by `handleToolCall` for this `event.toolCallId`. The context entry is
 * always removed in a `finally` block after filtering completes (success or
 * error) — it is call-scoped only and must never leak to sibling/later calls
 * or into `GrantStore`.
 */
export async function handleGrepResult(
  event: ToolResultEvent,
  deps: {
    rules: ParsedRule[];
    projectRoot: string;
    grants: GrantStore;
    callContexts: Map<string, string>;
    projectGrants?: ParsedGrant[];
    protectedIdentities?: ProtectedIdentity[];
  },
): Promise<{ content: ToolResultEvent["content"] } | undefined> {
  if (event.toolName !== "grep") return undefined;

  const approvedRoot = deps.callContexts.get(event.toolCallId);

  try {
    const inputPath = (event.input.path as string | undefined) ?? ".";
    const resolvedInput = resolve(deps.projectRoot, inputPath);

    // Determine searchRoot: grep emits paths relative to its search target.
    // When the target is a file, grep emits basename only, so searchRoot must
    // be the file's parent directory. Fall back to treating path as a directory
    // if stat fails (degrades to fail-closed dropping, not leaking).
    // Note: divergence from resolveToCwd normalization (Unicode spaces, @-prefix)
    // is acceptable — unresolvable paths are dropped, not leaked.
    let searchRoot: string;
    try {
      const s = await stat(resolvedInput);
      searchRoot = s.isDirectory() ? resolvedInput : dirname(resolvedInput);
    } catch {
      searchRoot = resolvedInput;
    }

    let anyChanged = false;
    const newParts: typeof event.content = [];

    for (const part of event.content) {
      if (part.type !== "text") {
        newParts.push(part);
        continue;
      }

      const result = await filterGrepOutput(
        part.text,
        searchRoot,
        deps.rules,
        deps.projectRoot,
        deps.grants,
        approvedRoot,
        deps.projectGrants,
        deps.protectedIdentities,
      );

      if (result.changed) anyChanged = true;
      newParts.push({ type: "text", text: result.text });
    }

    if (!anyChanged) return undefined;

    return { content: newParts };
  } catch (_err) {
    return {
      content: [{ type: "text", text: "[pi-ward] grep output suppressed (filter error)" }],
    };
  } finally {
    deps.callContexts.delete(event.toolCallId);
  }
}

/**
 * Best-effort collect and merge current on-disk identities for the exact
 * global config, the project's `ward.id` (protectRead), and its current
 * grants file, into `identities`. Used when a reload fails partway through
 * — e.g. after an atomic replacement changed an inode, or a grants file's
 * content became malformed — so self-protection still covers the files that
 * are actually on disk right now, in addition to whatever was already being
 * protected. The `ward.id` identity is captured independently, before its
 * contents are read/validated: atomic replacement changes its inode
 * regardless of whether the new content is a valid id, so a malformed or
 * unreadable `ward.id` must not prevent protecting its current inode — it
 * only prevents deriving the grants-file identity from it. Every step is
 * independently best-effort: a failure in one simply skips that identity
 * rather than aborting the others. Deduplicates against `identities` (and
 * across the identities computed here) by `(dev, ino, protectRead)` so a
 * reload storm does not accumulate unbounded duplicate entries.
 */
async function refreshIdentitiesBestEffort(
  projectRoot: string,
  identities: ProtectedIdentity[],
): Promise<ProtectedIdentity[]> {
  let next = identities;

  const merge = (candidate: ProtectedIdentity): void => {
    const isDup = next.some(
      (id) => id.dev === candidate.dev && id.ino === candidate.ino && !!id.protectRead === !!candidate.protectRead,
    );
    if (!isDup) next = [...next, candidate];
  };

  try {
    merge(await identityFor(globalConfigPath()));
  } catch {
    // Best effort — leave identities unchanged if the global config can't be stat'd.
  }

  // Capture the exact current on-disk ward.id identity first, independent of
  // whether its contents can be parsed as a valid project id — atomic
  // replacement changes its inode regardless of content validity, and a
  // malformed id must not prevent this best-effort protection.
  try {
    merge({ ...(await identityFor(projectIdPath(projectRoot))), protectRead: true });
  } catch {
    // Best effort — skip the ward.id identity if it can't be stat'd.
  }

  // Read/validate the id only to derive the grants-file identity. A
  // malformed/unreadable ward.id prevents grants lookup but must not prevent
  // the ward.id inode protection captured above.
  try {
    const id = await readProjectId(projectRoot);
    if (id !== null) {
      try {
        const grantsPath = await canonicalGrantsPath(id);
        merge(await identityFor(grantsPath));
      } catch {
        // Best effort — skip the grants file identity (missing/escaped/unreadable).
      }
    }
  } catch {
    // ward.id itself is malformed/unreadable — can't derive a grants path either.
  }

  return next;
}

/**
 * Reload the global policy and the active project's persistent grants after a
 * persistent `/ward project allow|revoke` write, so enforcement and
 * `/ward status` reflect it immediately.
 *
 * On failure, the caller should retain its prior in-memory `rules` and
 * `projectGrants` (a disk write already succeeded in the `/ward project`
 * case), but must still fold in freshly-observed on-disk identities — the
 * replacement global config, the project's `ward.id`, and its current grants
 * file — into `protectedIdentities` so alias self-protection does not
 * regress. Atomic replacement changes a file's inode, so this must happen
 * even when the full reload itself fails (including when grant parsing or
 * target resolution fails after such a replacement). Every identity refresh
 * step is best-effort and independent of the others; prior identities are
 * never dropped.
 *
 * A malformed/unreadable active `ward.id` or grants file also fails the
 * reload (fail-closed) rather than being silently treated as "no persistent
 * grants" — the caller retains the previous in-memory grants in that case.
 */
export async function reloadWardPolicy(
  projectRoot: string,
  homeDir: string,
  protectedIdentities: ProtectedIdentity[],
  projectGrants: ParsedGrant[] = [],
): Promise<
  | { ok: true; rules: ParsedRule[]; protectedIdentities: ProtectedIdentity[]; projectGrants: ParsedGrant[] }
  | { ok: false; reason: string; protectedIdentities: ProtectedIdentity[]; projectGrants: ParsedGrant[] }
> {
  try {
    const result = await loadConfig(homeDir);
    const state = await loadProjectGrantState(projectRoot, homeDir);
    return {
      ok: true,
      rules: result.rules,
      protectedIdentities: [...result.protectedIdentities, ...state.identities],
      projectGrants: state.grants,
    };
  } catch (err) {
    const nextIdentities = await refreshIdentitiesBestEffort(projectRoot, protectedIdentities);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      protectedIdentities: nextIdentities,
      projectGrants,
    };
  }
}

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = await realpath(process.cwd());
  const homeDir = await realpath(homedir());
  let rules: ParsedRule[] = [];
  let protectedIdentities: ProtectedIdentity[] = [];
  let projectGrants: ParsedGrant[] = [];
  // Set when the initial policy load fails (malformed global config,
  // malformed/unreadable project ward.id or grants file). While set, every
  // guarded file operation is blocked (fail-closed) and `/ward` refuses to
  // run any subcommand — it reports that repair + a reload/restart is
  // required rather than mutating or reporting against a policy it never
  // actually loaded. Non-file/unrecognized tools (extractAccess returns
  // `null`) and tool registration/hook registration are unaffected.
  let startupError: string | undefined;
  try {
    const configResult = await loadConfig(homeDir);
    rules = configResult.rules;
    protectedIdentities = configResult.protectedIdentities;
    const state = await loadProjectGrantState(projectRoot, homeDir);
    projectGrants = state.grants;
    protectedIdentities = [...protectedIdentities, ...state.identities];
  } catch (err) {
    startupError = err instanceof Error ? err.message : String(err);
  }
  const grants = new GrantStore();
  let latestPrompt: string | undefined;
  const callContexts = new Map<string, string>();

  async function reloadPolicy(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await reloadWardPolicy(projectRoot, homeDir, protectedIdentities, projectGrants);
    protectedIdentities = result.protectedIdentities;
    projectGrants = result.projectGrants;
    if (result.ok) {
      rules = result.rules;
      return { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  pi.registerTool(createDeleteTool(projectRoot));
  pi.registerTool(createMoveTool(projectRoot));

  pi.registerCommand("ward", {
    description: "Manage session access grants",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      await wardCommandHandler(args, ctx, {
        rules,
        projectRoot,
        homeDir,
        grants,
        protectedIdentities,
        projectGrants,
        reloadPolicy,
        startupError,
      });
    },
  });

  pi.on("input", async (event, _ctx) => {
    if (GENUINE_INPUT_SOURCES.has(event.source)) {
      latestPrompt = event.text;
    }
    return undefined;
  });

  pi.on("tool_result", async (event, _ctx) =>
    handleGrepResult(event, { rules, projectRoot, grants, callContexts, projectGrants, protectedIdentities }),
  );

  pi.on("tool_call", async (event, ctx) =>
    handleToolCall(event, ctx, pi.events, {
      rules,
      projectRoot,
      homeDir,
      grants,
      latestPrompt,
      callContexts,
      protectedIdentities,
      projectGrants,
      startupError,
    }),
  );
};

export default factory;
