import { Type } from "typebox";

const RuleSchema = Type.Object({
  pattern: Type.String(),
  operations: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
  effect: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
});

export const WardConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  rules: Type.Array(RuleSchema),
});
