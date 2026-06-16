import { Type } from "typebox";

const RuleSchema = Type.Object({
  pattern: Type.String({
    description:
      "Path pattern to match. No prefix = unanchored segment match (e.g. `.env`, `*.pem`); `./` = anchored to the config directory; `~/` = anchored to the home directory; `/` = absolute path anchor (global config only, for paths outside `~`); trailing `/` = directory match (the node itself and everything under it); `*` = wildcard matching one or more characters within a single segment.",
    examples: [
      ".env",
      "*.pem",
      ".env*",
      ".secret/",
      "./",
      "./src/*.ts",
      "~/",
      "~/.ssh/",
      "~/.config/",
      "/tmp/pi-github-repos/",
      "/var/log/*.log",
    ],
  }),
  operations: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
  effect: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  projectRoot: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
      description:
        "When set, this rule only applies when the active session's project root exactly matches the given path (or any path in the array). Only valid in the global config (~/.pi/agent/ward.json). Supports absolute paths and `~/`-prefixed home-relative paths.",
      examples: ["~/projects/backend", ["/home/user/projects/frontend", "~/projects/backend"]],
    }),
  ),
});

export const WardConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  rules: Type.Array(RuleSchema),
});
