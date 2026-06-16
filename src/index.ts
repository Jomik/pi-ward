import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { wardCommandHandler } from "./command.js";
import { loadConfig } from "./config.js";
import { isDirectory } from "./fs-utils.js";
import { GrantStore } from "./grants.js";
import { filterGrepOutput } from "./grep-filter.js";
import { checkPath } from "./guard.js";
import type { Operation } from "./rules.js";
import { createDeleteTool } from "./tools/delete.js";
import { createMoveTool } from "./tools/move.js";

/** Mirrors AutocompleteItem from @earendil-works/pi-tui (not a direct project dependency). */
type AutocompleteItem = { value: string; label: string; description?: string };

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

async function promptAccess(
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
}

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = await realpath(process.cwd());
  const homeDir = await realpath(homedir());
  const { rules } = await loadConfig(projectRoot, homeDir);
  const grants = new GrantStore();

  pi.registerTool(createDeleteTool(projectRoot));
  pi.registerTool(createMoveTool(projectRoot));

  pi.registerCommand("ward", {
    description: "Manage session access grants",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const spaceIdx = prefix.indexOf(" ");

      if (spaceIdx === -1) {
        // User is still typing the subcommand.
        const subcommands: AutocompleteItem[] = [
          { value: "allow", label: "allow", description: "Grant session access to a path" },
          { value: "deny", label: "deny", description: "Preemptively deny session access to a path" },
          { value: "list", label: "list", description: "Show active session grants and denies" },
          { value: "revoke", label: "revoke", description: "Remove a session grant or deny for a path" },
          { value: "status", label: "status", description: "Show what rules and grants apply to a path" },
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

      return null;
    },
    handler: async (args, ctx) => {
      await wardCommandHandler(args, ctx, { rules, projectRoot, homeDir, grants });
    },
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "grep") return undefined;

    try {
      const inputPath = (event.input.path as string | undefined) ?? ".";
      const resolvedInput = resolve(projectRoot, inputPath);

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

        const result = await filterGrepOutput(part.text, searchRoot, rules, projectRoot, grants);

        if (result.changed) anyChanged = true;
        newParts.push({ type: "text", text: result.text });
      }

      if (!anyChanged) return undefined;

      return { content: newParts };
    } catch (_err) {
      return {
        content: [{ type: "text", text: "[pi-ward] grep output suppressed (filter error)" }],
      };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      const dispatch = extractAccess(event, projectRoot);
      if (dispatch === null) {
        return undefined;
      }

      const { operation, paths } = dispatch;

      for (const inputPath of paths) {
        const result = await checkPath(event.toolName, inputPath, operation, rules, projectRoot, grants);
        if (result.allowed) continue;
        if (!result.grantable) return { block: true, reason: result.reason };

        const blocked = await promptAccess(ctx, event.toolName, operation, inputPath, result.resolvedPath, grants);
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
  });
};

export default factory;
