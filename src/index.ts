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
      { value: "project", label: "project", description: "Manage persisted project-scoped policy rules" },
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
        { value: "project allow", label: "allow", description: "Persist an allow rule for this project" },
        { value: "project deny", label: "deny", description: "Persist a deny rule for this project" },
        { value: "project list", label: "list", description: "List persisted rules for this project" },
      ];
      const filtered = subcommands.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    }

    const projectSub = afterProject.slice(0, projectSpaceIdx);
    if (projectSub === "allow" || projectSub === "deny") {
      const afterSub = afterProject.slice(projectSpaceIdx + 1);
      const operations: AutocompleteItem[] = [
        {
          value: `project ${projectSub} read`,
          label: "read",
          description: `Persist a read ${projectSub} rule for this project`,
        },
        {
          value: `project ${projectSub} write`,
          label: "write",
          description: `Persist a read+write ${projectSub} rule for this project`,
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

export async function promptAccess(
  events: { emit(channel: string, data: unknown): void },
  ctx: { hasUI: boolean; ui: { select(msg: string, options: string[]): Promise<string | undefined> } },
  toolName: string,
  operation: Operation,
  inputPath: string,
  resolvedPath: string,
  grants: GrantStore,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `[pi-ward] Blocked ${toolName} (${operation}) on ${inputPath}: outside project root`,
    };
  }

  events.emit("herdr:blocked", { active: true, label: `Ward approval: ${operation} ${inputPath}` });
  try {
    const action = await ctx.ui.select(`Access outside project root:\n\n  ${operation} ${inputPath}`, [
      "Deny",
      "Approve",
    ]);

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

    const scope = await ctx.ui.select("Approve scope:", ["Once", "For session"]);
    if (scope === "For session") {
      const dir = await isDirectory(resolvedPath);
      grants.addAllow(resolvedPath, operation, dir);
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
  },
): Promise<{ block?: boolean; reason?: string } | undefined> {
  try {
    const dispatch = extractAccess(event, deps.projectRoot);
    if (dispatch === null) {
      return undefined;
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
 * Reload the complete global+project policy after a persistent `/ward project
 * allow|deny` write, so enforcement and `/ward status` reflect it
 * immediately.
 *
 * On failure, the caller should retain its prior in-memory `rules` (the disk
 * write already succeeded), but must still fold in `newIdentity` — the
 * replacement global config's on-disk identity — into `protectedIdentities`
 * so alias self-protection does not regress. Atomic replacement changes the
 * global config's inode, so this must happen even when the full reload
 * itself fails. Prior identities are never dropped.
 */
export async function reloadWardPolicy(
  projectRoot: string,
  homeDir: string,
  protectedIdentities: ProtectedIdentity[],
): Promise<
  | { ok: true; rules: ParsedRule[]; protectedIdentities: ProtectedIdentity[] }
  | { ok: false; reason: string; protectedIdentities: ProtectedIdentity[] }
> {
  try {
    const result = await loadConfig(projectRoot, homeDir);
    return { ok: true, rules: result.rules, protectedIdentities: result.protectedIdentities };
  } catch (err) {
    let nextIdentities = protectedIdentities;
    try {
      const newIdentity = await identityFor(globalConfigPath());
      nextIdentities = [...protectedIdentities, newIdentity];
    } catch {
      // Best effort — if the replacement global config can't even be stat'd,
      // leave protectedIdentities unchanged rather than fail the whole reload path.
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err), protectedIdentities: nextIdentities };
  }
}

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = await realpath(process.cwd());
  const homeDir = await realpath(homedir());
  let { rules, protectedIdentities } = await loadConfig(projectRoot, homeDir);
  const grants = new GrantStore();
  let latestPrompt: string | undefined;
  const callContexts = new Map<string, string>();

  async function reloadPolicy(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await reloadWardPolicy(projectRoot, homeDir, protectedIdentities);
    protectedIdentities = result.protectedIdentities;
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
        reloadPolicy,
      });
    },
  });

  pi.on("input", async (event, _ctx) => {
    if (GENUINE_INPUT_SOURCES.has(event.source)) {
      latestPrompt = event.text;
    }
    return undefined;
  });

  pi.on("tool_result", async (event, _ctx) => handleGrepResult(event, { rules, projectRoot, grants, callContexts }));

  pi.on("tool_call", async (event, ctx) =>
    handleToolCall(event, ctx, pi.events, {
      rules,
      projectRoot,
      homeDir,
      grants,
      latestPrompt,
      callContexts,
      protectedIdentities,
    }),
  );
};

export default factory;
