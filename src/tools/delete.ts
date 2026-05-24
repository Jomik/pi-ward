import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function createDeleteTool(projectRoot: string) {
  return defineTool({
    name: "delete",
    label: "Delete",
    description: "Delete a file or empty directory.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file or empty directory to delete" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolve(projectRoot, params.path);
      try {
        await rm(target);
        return {
          content: [{ type: "text" as const, text: `Deleted: ${target}` }],
          details: undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: undefined,
        };
      }
    },
  });
}
