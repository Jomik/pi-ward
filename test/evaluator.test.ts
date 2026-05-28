import { describe, expect, it } from "vitest";
import { type EvaluateResult, evaluate } from "../src/evaluator.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";

/** Helper: extract the effect from an EvaluateResult. */
function effect(result: EvaluateResult): "allow" | "deny" {
  return result.effect;
}

const PROJECT_ROOT = "/home/user/project";

/** Build a ParsedRule conveniently. */
function rule(
  pattern: string,
  effect: "allow" | "deny",
  configDir: string,
  operations?: "read" | "write",
  homeDir?: string,
): ParsedRule {
  return {
    pattern: parsePattern(pattern),
    operations: operations ?? "read",
    effect,
    configDir,
    homeDir: homeDir ?? configDir,
  };
}

// ---------------------------------------------------------------------------
// Baseline policy (no rules)
// ---------------------------------------------------------------------------

describe("baseline policy — no rules", () => {
  it("allows read inside project root", () => {
    expect(effect(evaluate([], "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT))).toBe("allow");
  });

  it("allows write inside project root", () => {
    expect(effect(evaluate([], "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT))).toBe("allow");
  });

  it("allows access at the project root itself", () => {
    expect(effect(evaluate([], "read", PROJECT_ROOT, PROJECT_ROOT))).toBe("allow");
  });

  it("denies read outside project root with source=baseline", () => {
    const result = evaluate([], "read", "/home/user/.ssh/id_rsa", PROJECT_ROOT);
    expect(result).toEqual({ effect: "deny", source: "baseline" });
  });

  it("denies write outside project root with source=baseline", () => {
    const result = evaluate([], "write", "/etc/passwd", PROJECT_ROOT);
    expect(result).toEqual({ effect: "deny", source: "baseline" });
  });
});

// ---------------------------------------------------------------------------
// First-match-wins
// ---------------------------------------------------------------------------

describe("first-match-wins", () => {
  it("first matching rule wins over later rules", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT), rule("./", "allow", PROJECT_ROOT)];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toEqual({
      effect: "deny",
      source: "rule",
    });
  });

  it("second rule applies when first does not match", () => {
    const rules: ParsedRule[] = [rule(".env", "deny", PROJECT_ROOT), rule("./src/", "allow", PROJECT_ROOT)];
    expect(effect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT))).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Operation semantics — "write implies read"
// ---------------------------------------------------------------------------

describe("operation semantics", () => {
  // allow + "read": covers only reads
  it("allow+read covers a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "read")];
    expect(effect(evaluate(rules, "read", "/home/user/other/file.ts", PROJECT_ROOT))).toBe("allow");
  });

  it("allow+read does NOT cover a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "read")];
    expect(effect(evaluate(rules, "write", "/home/user/other/file.ts", PROJECT_ROOT))).toBe("deny");
  });

  // allow + "write": covers both reads and writes
  it("allow+write covers a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "write")];
    expect(effect(evaluate(rules, "read", "/home/user/other/file.ts", PROJECT_ROOT))).toBe("allow");
  });

  it("allow+write covers a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "write")];
    expect(effect(evaluate(rules, "write", "/home/user/other/file.ts", PROJECT_ROOT))).toBe("allow");
  });

  // deny + "read": covers both reads and writes
  it("deny+read covers a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "read")];
    expect(effect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT))).toBe("deny");
  });

  it("deny+read also covers a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "read")];
    expect(effect(evaluate(rules, "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT))).toBe("deny");
  });

  // deny + "write": covers only writes
  it("deny+write covers a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "write")];
    expect(effect(evaluate(rules, "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT))).toBe("deny");
  });

  it("deny+write does NOT cover a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "write")];
    expect(effect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT))).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Trust scoping
// ---------------------------------------------------------------------------

describe("trust scoping", () => {
  it("project config allow rule works within project", () => {
    const rules: ParsedRule[] = [rule(".env*", "allow", PROJECT_ROOT, "read")];
    expect(effect(evaluate(rules, "read", `${PROJECT_ROOT}/.env.local`, PROJECT_ROOT))).toBe("allow");
  });

  it("project config allow rule is skipped for paths outside its configDir", () => {
    const rules: ParsedRule[] = [rule(".env*", "allow", PROJECT_ROOT, "read")];
    expect(effect(evaluate(rules, "read", "/home/user/.env.local", PROJECT_ROOT))).toBe("deny");
  });

  it("project config allow for outside path falls through to baseline deny", () => {
    const rules: ParsedRule[] = [rule("secrets", "allow", PROJECT_ROOT, "read")];
    expect(effect(evaluate(rules, "read", "/home/user/secrets", PROJECT_ROOT))).toBe("deny");
  });

  it("global config allow (configDir = ~) works for any path", () => {
    const home = "/home/user";
    const rules: ParsedRule[] = [rule("./", "allow", home, "write")];
    expect(effect(evaluate(rules, "read", `${home}/other-project/file.ts`, PROJECT_ROOT))).toBe("allow");
  });

  it("global config allow does not apply for paths outside its own configDir", () => {
    const home = "/home/user";
    const rules: ParsedRule[] = [rule("./", "allow", home, "write")];
    expect(effect(evaluate(rules, "read", "/etc/passwd", PROJECT_ROOT))).toBe("deny");
  });

  it("deny rule works regardless of scope — from project config, denies outside path", () => {
    const rules: ParsedRule[] = [rule(".ssh/", "deny", PROJECT_ROOT)];
    expect(evaluate(rules, "read", "/home/user/.ssh/id_rsa", PROJECT_ROOT)).toEqual({ effect: "deny", source: "rule" });
  });

  it("deny rule works regardless of scope — from project config, denies inside path (write-only)", () => {
    const rules: ParsedRule[] = [rule(".git/", "deny", PROJECT_ROOT, "write")];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/.git/config`, PROJECT_ROOT)).toEqual({
      effect: "deny",
      source: "rule",
    });
  });

  it("deny rule is not subject to trust scoping", () => {
    const rules: ParsedRule[] = [rule("passwd", "deny", PROJECT_ROOT)];
    expect(evaluate(rules, "read", "/etc/passwd", PROJECT_ROOT)).toEqual({ effect: "deny", source: "rule" });
    const insideRules: ParsedRule[] = [rule("index.ts", "deny", PROJECT_ROOT)];
    expect(evaluate(insideRules, "read", `${PROJECT_ROOT}/index.ts`, PROJECT_ROOT)).toEqual({
      effect: "deny",
      source: "rule",
    });
  });
});

// ---------------------------------------------------------------------------
// Home-anchored patterns
// ---------------------------------------------------------------------------

describe("home-anchored patterns", () => {
  const HOME_DIR = "/home/user";

  it("home-anchored allow rule from global config (configDir = HOME_DIR) allows path within home", () => {
    const rules: ParsedRule[] = [rule("~/.ssh/", "allow", HOME_DIR, "read", HOME_DIR)];
    expect(effect(evaluate(rules, "read", `${HOME_DIR}/.ssh/id_rsa`, PROJECT_ROOT))).toBe("allow");
  });

  it("home-anchored allow rule from project config is trust-scoped to configDir, not to home", () => {
    const rules: ParsedRule[] = [rule("~/.ssh/", "allow", PROJECT_ROOT, "read", HOME_DIR)];
    expect(effect(evaluate(rules, "read", `${HOME_DIR}/.ssh/id_rsa`, PROJECT_ROOT))).toBe("deny");
  });

  it("home-anchored deny rule works regardless of scope", () => {
    const rules: ParsedRule[] = [rule("~/.ssh/", "deny", PROJECT_ROOT, "read", HOME_DIR)];
    expect(evaluate(rules, "read", `${HOME_DIR}/.ssh/id_rsa`, PROJECT_ROOT)).toEqual({
      effect: "deny",
      source: "rule",
    });
  });

  it("home-anchored allow from group config passes when path is within both homeDir and configDir", () => {
    const groupConfigDir = "/home/user/projects";
    const rules: ParsedRule[] = [rule("~/projects/shared/", "allow", groupConfigDir, "read", HOME_DIR)];
    expect(effect(evaluate(rules, "read", `${groupConfigDir}/shared/lib.ts`, PROJECT_ROOT))).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Absolute-anchored patterns — trust scoping with configDir = "/"
// ---------------------------------------------------------------------------

describe("absolute-anchored patterns — trust scoping with configDir=/", () => {
  it("absolute-anchored allow rule grants access to path outside home and projectRoot", () => {
    const rules: ParsedRule[] = [rule("/tmp/pi-github-repos/", "allow", "/", "read")];
    expect(effect(evaluate(rules, "read", "/tmp/pi-github-repos/repo/file.ts", PROJECT_ROOT))).toBe("allow");
  });

  it("absolute-anchored allow rule grants access to the directory itself", () => {
    const rules: ParsedRule[] = [rule("/tmp/pi-github-repos/", "allow", "/", "read")];
    expect(effect(evaluate(rules, "read", "/tmp/pi-github-repos", PROJECT_ROOT))).toBe("allow");
  });

  it("absolute-anchored allow rule does not grant access to paths outside the pattern", () => {
    const rules: ParsedRule[] = [rule("/tmp/pi-github-repos/", "allow", "/", "read")];
    expect(effect(evaluate(rules, "read", "/tmp/other-dir/file.ts", PROJECT_ROOT))).toBe("deny");
  });

  it("absolute-anchored deny rule blocks access regardless of baseline", () => {
    const rules: ParsedRule[] = [rule("/tmp/forbidden/", "deny", "/")];
    expect(evaluate(rules, "read", "/tmp/forbidden/secret.key", PROJECT_ROOT)).toEqual({
      effect: "deny",
      source: "rule",
    });
  });

  it("absolute-anchored write allow grants both read and write", () => {
    const rules: ParsedRule[] = [rule("/tmp/scratch/", "allow", "/", "write")];
    expect(effect(evaluate(rules, "read", "/tmp/scratch/file.txt", PROJECT_ROOT))).toBe("allow");
    expect(effect(evaluate(rules, "write", "/tmp/scratch/file.txt", PROJECT_ROOT))).toBe("allow");
  });

  it("absolute-anchored read allow does not grant write", () => {
    const rules: ParsedRule[] = [rule("/tmp/pi-github-repos/", "allow", "/", "read")];
    expect(effect(evaluate(rules, "write", "/tmp/pi-github-repos/file.ts", PROJECT_ROOT))).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Cross-rule-type interaction: absolute-allow + unanchored-deny
// ---------------------------------------------------------------------------

describe("rule interaction — absolute-allow with unanchored-deny", () => {
  it("deny .env* before allow /tmp/repos/ — denies .env inside allowed dir", () => {
    const rules: ParsedRule[] = [rule(".env*", "deny", "/"), rule("/tmp/repos/", "allow", "/", "read")];
    expect(evaluate(rules, "read", "/tmp/repos/.env.local", PROJECT_ROOT)).toEqual({ effect: "deny", source: "rule" });
  });

  it("allow /tmp/repos/ before deny .env* — allows .env inside allowed dir (first-match-wins)", () => {
    const rules: ParsedRule[] = [rule("/tmp/repos/", "allow", "/", "read"), rule(".env*", "deny", "/")];
    expect(effect(evaluate(rules, "read", "/tmp/repos/.env.local", PROJECT_ROOT))).toBe("allow");
  });

  it("deny *.pem before allow /tmp/certs/ — denies .pem inside allowed dir", () => {
    const rules: ParsedRule[] = [rule("*.pem", "deny", "/"), rule("/tmp/certs/", "allow", "/", "read")];
    expect(evaluate(rules, "read", "/tmp/certs/server.pem", PROJECT_ROOT)).toEqual({ effect: "deny", source: "rule" });
  });
});
