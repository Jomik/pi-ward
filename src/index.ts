import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { guard } from "./guard.js";
import type { Operation } from "./rules.js";
import { getProtectedPaths } from "./self-protect.js";

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
  return null;
}

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = await realpath(process.cwd());
  const homeDir = await realpath(homedir());
  const { rules } = await loadConfig(projectRoot);
  const protectedPaths = getProtectedPaths(projectRoot, homeDir);

  pi.on("tool_call", async (event, _ctx) => {
    try {
      const dispatch = extractAccess(event, projectRoot);
      if (dispatch === null) {
        return undefined;
      }

      const { operation, paths } = dispatch;
      const result = await guard(event.toolName, paths, operation, rules, projectRoot, protectedPaths);
      if (!result.allowed) {
        return { block: true, reason: result.reason };
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
