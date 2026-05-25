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
// Operation semantics — "write implies read"
// ---------------------------------------------------------------------------

describe("operation semantics", () => {
  // allow + "read": covers only reads
  it("allow+read covers a read operation", () => {
    // Path outside project (baseline deny) — rule must be the deciding factor
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "read")];
    expect(evaluate(rules, "read", "/home/user/other/file.ts", PROJECT_ROOT)).toBe("allow");
  });

  it("allow+read does NOT cover a write operation", () => {
    // Path outside project (baseline deny). allow+read doesn't apply for write → deny.
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "read")];
    expect(evaluate(rules, "write", "/home/user/other/file.ts", PROJECT_ROOT)).toBe("deny");
  });

  // allow + "write": covers both reads and writes
  it("allow+write covers a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "write")];
    expect(evaluate(rules, "read", "/home/user/other/file.ts", PROJECT_ROOT)).toBe("allow");
  });

  it("allow+write covers a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "allow", "/home/user", "write")];
    expect(evaluate(rules, "write", "/home/user/other/file.ts", PROJECT_ROOT)).toBe("allow");
  });

  // deny + "read": covers both reads and writes
  it("deny+read covers a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "read")];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("deny");
  });

  it("deny+read also covers a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "read")];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("deny");
  });

  // deny + "write": covers only writes
  it("deny+write covers a write operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "write")];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("deny");
  });

  it("deny+write does NOT cover a read operation", () => {
    const rules: ParsedRule[] = [rule("./", "deny", PROJECT_ROOT, "write")];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/src/index.ts`, PROJECT_ROOT)).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Trust scoping
// ---------------------------------------------------------------------------

describe("trust scoping", () => {
  it("project config allow rule works within project", () => {
    const rules: ParsedRule[] = [rule(".env*", "allow", PROJECT_ROOT, "read")];
    expect(evaluate(rules, "read", `${PROJECT_ROOT}/.env.local`, PROJECT_ROOT)).toBe("allow");
  });

  it("project config allow rule is skipped for paths outside its configDir", () => {
    // Rule's configDir is the project root, but the pattern could unanchored-match
    // something outside. The trust check prevents it.
    const rules: ParsedRule[] = [rule(".env*", "allow", PROJECT_ROOT, "read")];
    // Path is outside the project (and outside configDir)
    expect(evaluate(rules, "read", "/home/user/.env.local", PROJECT_ROOT)).toBe("deny");
  });

  it("project config allow for outside path falls through to baseline deny", () => {
    // Unanchored pattern can match outside — but trust scoping skips the allow.
    const rules: ParsedRule[] = [rule("secrets", "allow", PROJECT_ROOT, "read")];
    expect(evaluate(rules, "read", "/home/user/secrets", PROJECT_ROOT)).toBe("deny");
  });

  it("global config allow (configDir = ~) works for any path", () => {
    const home = "/home/user";
    const rules: ParsedRule[] = [rule("./", "allow", home, "write")];
    // Path is at ~/other-project/file.ts — within ~
    expect(evaluate(rules, "read", `${home}/other-project/file.ts`, PROJECT_ROOT)).toBe("allow");
  });

  it("global config allow does not apply for paths outside its own configDir", () => {
    // If configDir is /home/user, a path at /etc is outside → skipped.
    const home = "/home/user";
    const rules: ParsedRule[] = [rule("./", "allow", home, "write")];
    expect(evaluate(rules, "read", "/etc/passwd", PROJECT_ROOT)).toBe("deny");
  });

  it("deny rule works regardless of scope — from project config, denies outside path", () => {
    const rules: ParsedRule[] = [rule(".ssh/", "deny", PROJECT_ROOT)];
    expect(evaluate(rules, "read", "/home/user/.ssh/id_rsa", PROJECT_ROOT)).toBe("deny");
  });

  it("deny rule works regardless of scope — from project config, denies inside path (write-only)", () => {
    const rules: ParsedRule[] = [rule(".git/", "deny", PROJECT_ROOT, "write")];
    expect(evaluate(rules, "write", `${PROJECT_ROOT}/.git/config`, PROJECT_ROOT)).toBe("deny");
  });

  it("deny rule is not subject to trust scoping", () => {
    // A deny from any config dir can block any path.
    const rules: ParsedRule[] = [rule("passwd", "deny", PROJECT_ROOT)];
    expect(evaluate(rules, "read", "/etc/passwd", PROJECT_ROOT)).toBe("deny");
    // Also verify with path inside projectRoot to isolate rule from baseline
    const insideRules: ParsedRule[] = [rule("index.ts", "deny", PROJECT_ROOT)];
    expect(evaluate(insideRules, "read", `${PROJECT_ROOT}/index.ts`, PROJECT_ROOT)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Home-anchored patterns
// ---------------------------------------------------------------------------

describe("home-anchored patterns", () => {
  const HOME_DIR = "/home/user";

  it("home-anchored allow rule from global config (configDir = HOME_DIR) allows path within home", () => {
    // configDir = HOME_DIR, homeDir = HOME_DIR → trust scope is HOME_DIR, pattern anchored to HOME_DIR
    const rules: ParsedRule[] = [rule("~/.ssh/", "allow", HOME_DIR, "read", HOME_DIR)];
    expect(evaluate(rules, "read", `${HOME_DIR}/.ssh/id_rsa`, PROJECT_ROOT)).toBe("allow");
  });

  it("home-anchored allow rule from project config is trust-scoped to configDir, not to home", () => {
    // configDir = PROJECT_ROOT, homeDir = HOME_DIR
    // ~/.ssh/id_rsa is in homeDir but not within PROJECT_ROOT → trust scope blocks the allow
    const rules: ParsedRule[] = [rule("~/.ssh/", "allow", PROJECT_ROOT, "read", HOME_DIR)];
    expect(evaluate(rules, "read", `${HOME_DIR}/.ssh/id_rsa`, PROJECT_ROOT)).toBe("deny");
  });

  it("home-anchored deny rule works regardless of scope", () => {
    // Deny rules are not trust-scoped; PROJECT_ROOT config can deny a path in HOME_DIR
    const rules: ParsedRule[] = [rule("~/.ssh/", "deny", PROJECT_ROOT, "read", HOME_DIR)];
    expect(evaluate(rules, "read", `${HOME_DIR}/.ssh/id_rsa`, PROJECT_ROOT)).toBe("deny");
  });

  it("home-anchored allow from group config passes when path is within both homeDir and configDir", () => {
    // Group config at ~/projects (configDir = /home/user/projects)
    // Pattern: ~/projects/shared/ (resolves to /home/user/projects/shared/)
    // Path: /home/user/projects/shared/lib.ts — within configDir AND matches pattern
    const groupConfigDir = "/home/user/projects";
    const rules: ParsedRule[] = [rule("~/projects/shared/", "allow", groupConfigDir, "read", HOME_DIR)];
    expect(evaluate(rules, "read", `${groupConfigDir}/shared/lib.ts`, PROJECT_ROOT)).toBe("allow");
  });
});
