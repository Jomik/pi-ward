import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluator.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";

const PROJECT_ROOT = "/home/user/project";

/** Build a ParsedRule conveniently. */
function rule(
  pattern: string,
  effect: "allow" | "deny",
  configDir: string,
  operations?: ("read" | "write")[],
): ParsedRule {
  return {
    pattern: parsePattern(pattern),
    operations: operations ?? ["read", "write"],
    effect,
    configDir,
  };
}

// ---------------------------------------------------------------------------
// Baseline policy (no rules)
// ---------------------------------------------------------------------------

describe("baseline policy — no rules", () => {
  it("allows read inside project root", () => {
    expect(evaluate([], "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("allow");
  });

  it("allows write inside project root", () => {
    expect(evaluate([], "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("allow");
  });

  it("allows access at the project root itself", () => {
    expect(evaluate([], "read", PROJECT_ROOT, PROJECT_ROOT)).toBe("allow");
  });

  it("denies read outside project root", () => {
    expect(evaluate([], "read", "/home/user/.ssh/id_rsa", PROJECT_ROOT)).toBe("deny");
  });

  it("denies write outside project root", () => {
    expect(evaluate([], "write", "/etc/passwd", PROJECT_ROOT)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// First-match-wins
// ---------------------------------------------------------------------------

describe("first-match-wins", () => {
  it("first matching rule wins over later rules", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT), rule("./", "allow", PROJECT_ROOT)];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("deny");
  });

  it("second rule applies when first does not match", () => {
    const rules: ParsedRule[] = [rule(".env", "deny", PROJECT_ROOT), rule("./src/", "allow", PROJECT_ROOT)];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Operation filtering
// ---------------------------------------------------------------------------

describe("operation filtering", () => {
  it("write-only rule does not match a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, ["write"])];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("allow");
  });

  it("read-only rule does not match a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, ["read"])];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("allow");
  });

  it("write-only rule does match a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, ["write"])];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Default operations (rule with no operations specified)
// ---------------------------------------------------------------------------

describe("default operations", () => {
  it("rule with both operations matches read", () => {
    const rules: ParsedRule[] = [rule(".env*", "deny", PROJECT_ROOT, ["read", "write"])];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/.env.local`, PROJECT_ROOT)).toBe("deny");
  });

  it("rule with both operations matches write", () => {
    const rules: ParsedRule[] = [rule(".env*", "deny", PROJECT_ROOT, ["read", "write"])];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/.env.local`, PROJECT_ROOT)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Trust scoping
// ---------------------------------------------------------------------------

describe("trust scoping", () => {
  it("project config allow rule works within project", () => {
    const rules: ParsedRule[] = [rule(".env*", "allow", PROJECT_ROOT)];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/.env.local`, PROJECT_ROOT)).toBe("allow");
  });

  it("project config allow rule is skipped for paths outside its configDir", () => {
    // Rule's configDir is the project root, but the pattern could unanchored-match
    // something outside. The trust check prevents it.
    const rules: ParsedRule[] = [rule(".env*", "allow", PROJECT_ROOT)];
    // Path is outside the project (and outside configDir)
    expect(evaluate(rules, "read", "/home/user/.env.local", PROJECT_ROOT)).toBe("deny");
  });

  it("project config allow for outside path falls through to baseline deny", () => {
    // Unanchored pattern can match outside — but trust scoping skips the allow.
    const rules: ParsedRule[] = [rule("secrets", "allow", PROJECT_ROOT)];
    expect(evaluate(rules, "read", "/home/user/secrets", PROJECT_ROOT)).toBe("deny");
  });

  it("global config allow (configDir = ~) works for any path", () => {
    const home = "/home/user";
    const rules: ParsedRule[] = [rule("./", "allow", home)];
    // Path is at ~/other-project/file.ts — within ~
    expect(evaluate(rules, "read", `${home}/other-project/file.ts`, PROJECT_ROOT)).toBe("allow");
  });

  it("global config allow does not apply for paths outside its own configDir", () => {
    // If configDir is /home/user, a path at /etc is outside → skipped.
    const home = "/home/user";
    const rules: ParsedRule[] = [rule("./", "allow", home)];
    expect(evaluate(rules, "read", "/etc/passwd", PROJECT_ROOT)).toBe("deny");
  });

  it("deny rule works regardless of scope — from project config, denies outside path", () => {
    const rules: ParsedRule[] = [rule(".ssh/", "deny", PROJECT_ROOT)];
    expect(evaluate(rules, "read", "/home/user/.ssh/id_rsa", PROJECT_ROOT)).toBe("deny");
  });

  it("deny rule works regardless of scope — from project config, denies inside path", () => {
    const rules: ParsedRule[] = [rule(".git/", "deny", PROJECT_ROOT, ["write"])];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/.git/config`, PROJECT_ROOT)).toBe("deny");
  });

  it("deny rule is not subject to trust scoping", () => {
    // A deny from any config dir can block any path.
    const rules: ParsedRule[] = [rule("passwd", "deny", PROJECT_ROOT)];
    expect(evaluate(rules, "read", "/etc/passwd", PROJECT_ROOT)).toBe("deny");
  });
});
