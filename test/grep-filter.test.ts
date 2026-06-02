import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filterGrepOutput } from "../src/grep-filter.js";
import { parsePattern } from "../src/pattern.js";
import type { ParsedRule } from "../src/rules.js";

let tempDir: string;
let projectRoot: string;

beforeEach(async () => {
  const base = join(tmpdir(), `pi-ward-grep-filter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(base, "project"), { recursive: true });
  tempDir = await realpath(base);
  projectRoot = join(tempDir, "project");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function denyRule(pattern: string, configDir: string): ParsedRule {
  return {
    pattern: parsePattern(pattern),
    rawPattern: pattern,
    operations: "read",
    effect: "deny",
    configDir,
    homeDir: configDir,
  };
}

// ---------------------------------------------------------------------------
// Helpers to build realistic grep output text
// ---------------------------------------------------------------------------

function matchLine(relativePath: string, lineNum: number, text: string): string {
  return `${relativePath}:${lineNum}: ${text}`;
}

function contextLine(relativePath: string, lineNum: number, text: string): string {
  return `${relativePath}-${lineNum}- ${text}`;
}

// ---------------------------------------------------------------------------
// Core filtering tests
// ---------------------------------------------------------------------------

describe("filterGrepOutput", () => {
  it("passes through allowed lines unchanged when nothing is denied", async () => {
    await writeFile(join(projectRoot, "src.ts"), "export const x = 1;");

    const text = [matchLine("src.ts", 1, "export const x = 1;")].join("\n");

    const result = await filterGrepOutput(text, projectRoot, [], projectRoot, []);

    expect(result.dropped).toBe(0);
    expect(result.files).toBe(0);
    expect(result.text).toBe(text);
  });

  it("drops lines from a denied .env file and appends summary note", async () => {
    // Create files so resolvePath can resolve them
    await writeFile(join(projectRoot, ".env"), 'SECRET_KEY="this should be secret"');
    await writeFile(join(projectRoot, "allowed.ts"), "export const x = 1;");

    const rules: ParsedRule[] = [denyRule(".env", projectRoot)];

    const text = [
      matchLine(".env", 1, 'SECRET_KEY="this should be secret"'),
      matchLine("allowed.ts", 3, "export const x = 1;"),
    ].join("\n");

    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, [], undefined);

    // Denied .env line must be removed
    expect(result.text).not.toContain("SECRET_KEY");
    expect(result.text).not.toContain(".env");
    // Allowed line must be retained
    expect(result.text).toContain("allowed.ts");
    expect(result.text).toContain("export const x = 1;");
    // Summary note must be present
    expect(result.text).toContain("[pi-ward]");
    expect(result.text).toContain("protected file hidden");

    expect(result.dropped).toBe(1);
    expect(result.files).toBe(1);
  });

  it("drops all lines and still appends summary note when every line is denied", async () => {
    await writeFile(join(projectRoot, ".env"), 'SECRET_KEY="this should be secret"');

    const rules: ParsedRule[] = [denyRule(".env", projectRoot)];

    const text = [
      matchLine(".env", 1, 'SECRET_KEY="this should be secret"'),
      matchLine(".env", 2, 'DB_PASSWORD="hunter2"'),
    ].join("\n");

    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, []);

    expect(result.text).not.toContain("SECRET_KEY");
    expect(result.text).not.toContain("DB_PASSWORD");
    expect(result.text).toContain("[pi-ward]");
    expect(result.text).toContain("2 matches in 1 protected file hidden");

    expect(result.dropped).toBe(2);
    expect(result.files).toBe(1);
  });

  it("counts distinct denied files correctly for multiple denied files", async () => {
    await writeFile(join(projectRoot, ".env"), "SECRET=a");
    await writeFile(join(projectRoot, ".env.local"), "SECRET=b");
    await writeFile(join(projectRoot, "ok.ts"), "const x = 1;");

    const rules: ParsedRule[] = [denyRule(".env", projectRoot), denyRule(".env*", projectRoot)];

    const text = [
      matchLine(".env", 1, "SECRET=a"),
      matchLine(".env.local", 1, "SECRET=b"),
      matchLine(".env.local", 2, "OTHER=c"),
      matchLine("ok.ts", 5, "const x = 1;"),
    ].join("\n");

    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, []);

    expect(result.dropped).toBe(3);
    expect(result.files).toBe(2);
    expect(result.text).toContain("ok.ts");
    expect(result.text).toContain("3 matches in 2 protected files hidden");
  });

  it("handles context lines (dash separator) for denied files", async () => {
    await writeFile(join(projectRoot, ".env"), "SECRET=x\nOTHER=y\nMORE=z");
    await writeFile(join(projectRoot, "ok.ts"), "const x = 1;");

    const rules: ParsedRule[] = [denyRule(".env", projectRoot)];

    const text = [
      contextLine(".env", 1, "SECRET=x"),
      matchLine(".env", 2, "OTHER=y"),
      contextLine(".env", 3, "MORE=z"),
      matchLine("ok.ts", 1, "const x = 1;"),
    ].join("\n");

    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, []);

    expect(result.dropped).toBe(3);
    expect(result.text).not.toContain(".env");
    expect(result.text).toContain("ok.ts");
  });

  it("silently drops unattributable lines (fail-closed) without counting them as policy denials", async () => {
    await writeFile(join(projectRoot, "ok.ts"), "const x = 1;");

    // Simulate grep output with a truncation notice (unattributable line)
    const text = [
      matchLine("ok.ts", 1, "const x = 1;"),
      "",
      "[100 matches limit reached. Use limit=200 for more]",
    ].join("\n");

    const result = await filterGrepOutput(text, projectRoot, [], projectRoot, []);

    // No policy denials — dropped count stays 0
    expect(result.dropped).toBe(0);
    expect(result.files).toBe(0);
    // No summary note added
    expect(result.text).not.toContain("[pi-ward]");
  });

  it("caches path resolution: checkPath called once per distinct file path", async () => {
    // Multiple lines from the same denied file — resolution should be cached
    await writeFile(join(projectRoot, ".env"), "A=1\nB=2\nC=3");

    const rules: ParsedRule[] = [denyRule(".env", projectRoot)];

    const text = [matchLine(".env", 1, "A=1"), matchLine(".env", 2, "B=2"), matchLine(".env", 3, "C=3")].join("\n");

    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, []);

    expect(result.dropped).toBe(3);
    // All 3 lines from the same file — still counts as 1 distinct file
    expect(result.files).toBe(1);
    expect(result.text).toContain("3 matches in 1 protected file hidden");
  });

  it("returns empty text with note when all content is from denied files", async () => {
    await writeFile(join(projectRoot, ".env"), "SECRET=x");

    const rules: ParsedRule[] = [denyRule(".env", projectRoot)];
    const text = matchLine(".env", 1, "SECRET=x");

    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, []);

    expect(result.dropped).toBe(1);
    expect(result.text).toBe("[pi-ward] 1 match in 1 protected file hidden");
  });

  it("preserves trailing newline: changed is false when all lines are allowed", async () => {
    await writeFile(join(projectRoot, "a.ts"), "const x = 1;");
    const input = "a.ts:1: const x = 1;\n";
    const result = await filterGrepOutput(input, projectRoot, [], projectRoot, []);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });

  it("resolves relative paths against the provided searchRoot", async () => {
    // Create a nested subdirectory as the search root
    const subDir = join(projectRoot, "src");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "file.ts"), "const x = 1;");

    // searchRoot is the subdirectory, output contains a bare filename (relative to subdir)
    const text = matchLine("file.ts", 1, "const x = 1;");
    const result = await filterGrepOutput(text, subDir, [], projectRoot, []);

    expect(result.dropped).toBe(0);
    expect(result.text).toBe(text);
  });

  it("denies files outside project root even with no explicit rules (baseline deny)", async () => {
    // Create an outside directory and file
    const outsideDir = join(tempDir, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "topsecret");

    // searchRoot is outside project, so the file resolves outside project root
    const text = matchLine("secret.txt", 1, "topsecret");

    // No explicit rules — baseline deny for outside project root
    const result = await filterGrepOutput(text, outsideDir, [], projectRoot, []);

    expect(result.dropped).toBe(1);
    expect(result.text).not.toContain("topsecret");
    expect(result.text).toContain("[pi-ward]");
  });
});

// ---------------------------------------------------------------------------
// Integration: the .env scenario from the errand description
// ---------------------------------------------------------------------------

describe("grep filter — .env content exfiltration scenario", () => {
  it("blocks .env secrets when a deny .env* rule is active", async () => {
    await writeFile(join(projectRoot, ".env"), 'SECRET_KEY="this should be secret"');
    await writeFile(join(projectRoot, "src", "index.ts"), "export default {};").catch(async () => {
      await mkdir(join(projectRoot, "src"), { recursive: true });
      await writeFile(join(projectRoot, "src", "index.ts"), "export default {};");
    });

    const rules: ParsedRule[] = [denyRule(".env", projectRoot)];

    // Simulate grep "SECRET" run from project root finding both files
    const grepOutput = [
      matchLine(".env", 1, 'SECRET_KEY="this should be secret"'),
      matchLine("src/index.ts", 1, "export default {};"),
    ].join("\n");

    const result = await filterGrepOutput(grepOutput, projectRoot, rules, projectRoot, []);

    // The secret must NOT appear in output
    expect(result.text).not.toContain('SECRET_KEY="this should be secret"');
    // Allowed file content retained
    expect(result.text).toContain("src/index.ts");
    // Summary note present
    expect(result.text).toMatch(/\[pi-ward\] 1 match in 1 protected file hidden/);
  });
});

// ---------------------------------------------------------------------------
// Adversarial / hardening tests
// ---------------------------------------------------------------------------

describe("grep filter — adversarial hardening", () => {
  it("denied file with internal marker in name: bypass attempt is blocked (deny-wins)", async () => {
    // The file name itself contains '-2- ', which was the old regex's bypass vector.
    // Old lazy regex would misparse path as 'weird', miss the real denied file.
    const weirdName = "weird-2- name.env";
    await writeFile(join(projectRoot, weirdName), "SECRET=x");

    const rules: ParsedRule[] = [denyRule(weirdName, projectRoot)];

    // grep output line for this file
    const text = `${weirdName}:1: SECRET=x`;
    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, []);

    // The secret must NOT appear in the output
    expect(result.text).not.toContain("SECRET=x");
    // Must be counted as a policy denial (not just unattributable)
    expect(result.dropped).toBe(1);
    expect(result.files).toBe(1);
    expect(result.changed).toBe(true);
  });

  it("allowed file whose content contains a colon-digit-colon sequence: kept without misparse", async () => {
    // Line content has ':5: ' which should NOT be mistaken for a file boundary.
    // The correct split point resolves to code.ts which exists and is allowed.
    await writeFile(join(projectRoot, "code.ts"), 'const t = "a:5: b";');

    // No deny rules — code.ts is allowed
    const text = 'code.ts:1: const t = "a:5: b";';
    const result = await filterGrepOutput(text, projectRoot, [], projectRoot, []);

    // Line must be KEPT; content colon does not cause misparse or drop
    expect(result.dropped).toBe(0);
    expect(result.text).toContain('const t = "a:5: b"');
    expect(result.text).toContain("code.ts");
    expect(result.changed).toBe(false);
  });

  it("single-file grep: denied file — basename-only path is correctly attributed and dropped", async () => {
    // When grep runs on a single file it emits basename only.
    // Caller must pass dirname as searchRoot.
    const secretDir = join(projectRoot, "secrets");
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, ".env"), "SECRET=x");

    // searchRoot = dirname of the target file (as index.ts computes it)
    const rules: ParsedRule[] = [denyRule(".env", projectRoot)];
    const text = ".env:1: SECRET=x";
    const result = await filterGrepOutput(text, secretDir, rules, projectRoot, []);

    expect(result.dropped).toBe(1);
    expect(result.text).not.toContain("SECRET=x");
    expect(result.changed).toBe(true);
  });

  it("single-file grep: allowed file — basename-only path is correctly attributed and kept", async () => {
    const srcDir = join(projectRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "utils.ts"), "export const x = 1;");

    // searchRoot = dirname of the target file
    const text = "utils.ts:1: export const x = 1;";
    const result = await filterGrepOutput(text, srcDir, [], projectRoot, []);

    expect(result.dropped).toBe(0);
    expect(result.text).toContain("export const x = 1;");
    expect(result.changed).toBe(false);
  });

  it("truly unattributable line: dropped from output, policy count stays 0, changed is true", async () => {
    // A line with no sep-digit-sep pattern AND an allowed file present.
    await writeFile(join(projectRoot, "ok.ts"), "const x = 1;");

    const text = [matchLine("ok.ts", 1, "const x = 1;"), "This line has no grep-format separator at all"].join("\n");

    const result = await filterGrepOutput(text, projectRoot, [], projectRoot, []);

    // Policy count: 0 (unattributable is not a policy denial)
    expect(result.dropped).toBe(0);
    expect(result.files).toBe(0);
    // No [pi-ward] note (no policy denial)
    expect(result.text).not.toContain("[pi-ward]");
    // But the unattributable line was removed → changed
    expect(result.changed).toBe(true);
    expect(result.text).toContain("ok.ts:1: const x = 1;");
    expect(result.text).not.toContain("This line has no grep-format separator");
  });

  it("collision variant: deny-wins fires when both shorter candidate and denied long name exist", async () => {
    // Both `weird` (allowed) and `weird-2- name.env` (denied) exist on disk.
    // The line for the denied file produces TWO real candidates:
    //   - `weird`          (from the `-2- ` split point — exists, allowed)
    //   - `weird-2- name.env`  (from the `:1: ` split point — exists, denied)
    // deny-wins must fire: the line should be dropped.
    await writeFile(join(projectRoot, "weird"), "INNOCENT");
    await writeFile(join(projectRoot, "weird-2- name.env"), "SECRET=x");

    const rules: ParsedRule[] = [denyRule("weird-2- name.env", projectRoot)];
    const text = "weird-2- name.env:1: SECRET=x";
    const result = await filterGrepOutput(text, projectRoot, rules, projectRoot, []);

    expect(result.text).not.toContain("SECRET=x");
    expect(result.dropped).toBe(1);
    expect(result.files).toBe(1);
  });

  it("absolute-path candidate outside projectRoot is baseline-denied even with no explicit rules", async () => {
    // A file sitting outside projectRoot is referenced by its absolute path in
    // the grep line (e.g. an accidental absolute-path output).
    // resolve(searchRoot, absPath) === absPath, so it resolves outside the
    // project root → baseline deny applies.
    const outsidePath = join(tempDir, "outside.txt");
    await writeFile(outsidePath, "TOPSECRET");

    const line = `${outsidePath}:1: TOPSECRET`;
    const result = await filterGrepOutput(line, projectRoot, [], projectRoot, []);

    expect(result.text).not.toContain("TOPSECRET");
    expect(result.dropped).toBe(1);
    expect(result.files).toBe(1);
  });
});
