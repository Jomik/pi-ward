import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function createMoveTool(projectRoot: string) {
  return defineTool({
    name: "move",
    label: "Move",
    description: "Move or rename a file or directory.",
    parameters: Type.Object({
      source: Type.String({ description: "Current path of the file or directory" }),
      destination: Type.String({ description: "New path for the file or directory" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const src = resolve(projectRoot, params.source);
      const dest = resolve(projectRoot, params.destination);
      try {
        await mkdir(dirname(dest), { recursive: true });
        await rename(src, dest);
        return {
          content: [{ type: "text" as const, text: `Moved: ${src} → ${dest}` }],
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
