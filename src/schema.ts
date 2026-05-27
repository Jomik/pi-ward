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
});

export const WardConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  rules: Type.Array(RuleSchema),
});
