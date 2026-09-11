import { Type } from "typebox";

const RuleSchema = Type.Object(
  {
    pattern: Type.String({
      description:
        "Path pattern to match. No prefix = unanchored segment match, single segment matches any path segment (e.g. `.env`, `*.pem`) or multiple slash-delimited segments match a contiguous run — at the end of the path for non-directory patterns (e.g. `.pi/PLAN.md`), or anywhere (matching the node and all descendants) for directory patterns; `~/` = anchored to the home directory; `/` = absolute path anchor (global config only, for paths outside `~`); trailing `/` = directory match (the node itself and everything under it); `*` = wildcard matching one or more characters within a single segment.",
      examples: [
        ".env",
        "*.pem",
        ".env*",
        ".secret/",
        ".pi/PLAN.md",
        "~/",
        "~/.ssh/",
        "~/.config/",
        "/tmp/pi-github-repos/",
        "/var/log/*.log",
      ],
    }),
    operations: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
    effect: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  },
  { additionalProperties: false },
);

export const WardConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    rules: Type.Array(RuleSchema),
  },
  { additionalProperties: false },
);
