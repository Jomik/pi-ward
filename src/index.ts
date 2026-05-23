import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { guard } from "./guard.js";
import type { Operation } from "./rules.js";
import { getProtectedPaths } from "./self-protect.js";

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = process.cwd();
  const { rules } = await loadConfig(projectRoot);
  const protectedPaths = getProtectedPaths(projectRoot);

  pi.on("tool_call", async (event, _ctx) => {
    let operation: Operation;
    let paths: string[];

    if (event.toolName === "read") {
      operation = "read";
      const input = event.input as { path: string };
      paths = [input.path];
    } else if (event.toolName === "write") {
      operation = "write";
      const input = event.input as { path: string };
      paths = [input.path];
    } else if (event.toolName === "edit") {
      operation = "write";
      const input = event.input as { path: string };
      paths = [input.path];
    } else {
      return undefined;
    }

    const result = await guard(event.toolName, paths, operation, rules, projectRoot, protectedPaths);
    if (!result.allowed) {
      return { block: true, reason: result.reason };
    }
    return undefined;
  });
};

export default factory;
