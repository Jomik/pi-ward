import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPromptApproval } from "../src/prompt-approval.js";

let tempDir: string;
let projectRoot: string;

beforeEach(async () => {
  const base = join(tmpdir(), `pi-ward-prompt-approval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(base, "project"), { recursive: true });
  tempDir = await realpath(base);
  projectRoot = join(tempDir, "project");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("existing regular file", () => {
  it("approves a bare unquoted reference", async () => {
    const file = join(tempDir, "todo.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check ${file} please`, file, projectRoot);

    expect(result.approved).toBe(true);
    expect(result.isDirectory).toBe(false);
  });

  it("approves an @-marked reference", async () => {
    const file = join(tempDir, "todo.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check @${file} please`, file, projectRoot);

    expect(result.approved).toBe(true);
    expect(result.isDirectory).toBe(false);
  });

  it("approves an @-marked quoted reference with spaces", async () => {
    const file = join(tempDir, "my notes.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check @"${file}" please`, file, projectRoot);

    expect(result.approved).toBe(true);
  });

  it("approves a bare double-quoted reference with spaces", async () => {
    const file = join(tempDir, "my notes.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check "${file}" please`, file, projectRoot);

    expect(result.approved).toBe(true);
  });
});

describe("existing directory", () => {
  it("approves an @-marked reference", async () => {
    const dir = join(tempDir, "notes");
    await mkdir(dir);

    const result = await checkPromptApproval(`check @${dir} please`, dir, projectRoot);

    expect(result.approved).toBe(true);
    expect(result.isDirectory).toBe(true);
  });

  it("does not approve a bare unquoted reference", async () => {
    const dir = join(tempDir, "notes");
    await mkdir(dir);

    const result = await checkPromptApproval(`check ${dir} please`, dir, projectRoot);

    expect(result.approved).toBe(false);
    expect(result.isDirectory).toBe(true);
  });
});

describe("directory subtree approval", () => {
  it("approves a descendant file of an @-marked directory", async () => {
    const dir = join(tempDir, "notes");
    const file = join(dir, "todo.md");
    await mkdir(dir);
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check @${dir} please`, file, projectRoot);

    expect(result.approved).toBe(true);
    expect(result.isDirectory).toBe(false);
  });

  it("approves a descendant directory of an @-marked directory", async () => {
    const dir = join(tempDir, "notes");
    const sub = join(dir, "sub");
    await mkdir(sub, { recursive: true });

    const result = await checkPromptApproval(`check @${dir} please`, sub, projectRoot);

    expect(result.approved).toBe(true);
    expect(result.isDirectory).toBe(true);
  });

  it("approves a descendant via an @-marked quoted directory with spaces", async () => {
    const dir = join(tempDir, "my notes");
    const file = join(dir, "todo.md");
    await mkdir(dir);
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check @"${dir}" please`, file, projectRoot);

    expect(result.approved).toBe(true);
  });

  it("does not approve a descendant of a bare (unmarked) directory reference", async () => {
    const dir = join(tempDir, "notes");
    const file = join(dir, "todo.md");
    await mkdir(dir);
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check ${dir} please`, file, projectRoot);

    expect(result.approved).toBe(false);
  });

  it("does not approve a sibling of an @-marked directory", async () => {
    const dir = join(tempDir, "notes");
    const sibling = join(tempDir, "other");
    const file = join(sibling, "todo.md");
    await mkdir(dir);
    await mkdir(sibling);
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check @${dir} please`, file, projectRoot);

    expect(result.approved).toBe(false);
  });

  it("does not approve the parent of an @-marked directory", async () => {
    const dir = join(tempDir, "notes");
    await mkdir(dir);

    const result = await checkPromptApproval(`check @${dir} please`, tempDir, projectRoot);

    expect(result.approved).toBe(false);
  });

  it("does not approve another path from an @-marked file reference", async () => {
    const file = join(tempDir, "todo.md");
    const other = join(tempDir, "other.md");
    await writeFile(file, "content");
    await writeFile(other, "content");

    const result = await checkPromptApproval(`check @${file} please`, other, projectRoot);

    expect(result.approved).toBe(false);
  });
});

describe("missing target", () => {
  it("never approves, even when @-marked and textually present", async () => {
    const missing = join(tempDir, "nonexistent.md");

    const result = await checkPromptApproval(`check @${missing} please`, missing, projectRoot);

    expect(result.approved).toBe(false);
    expect(result.isDirectory).toBe(false);
  });
});

describe("adjacency and delimiter rules", () => {
  it("does not treat @ as a marker when separated from the path by a space", async () => {
    const dir = join(tempDir, "notes");
    await mkdir(dir);

    // "@ /path" — space after @ breaks adjacency; directory stays bare (unapproved).
    const result = await checkPromptApproval(`check @ ${dir} please`, dir, projectRoot);

    expect(result.approved).toBe(false);
  });

  it("strips trailing sentence punctuation from an unquoted bare candidate", async () => {
    const file = join(tempDir, "todo.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval(`Please check ${file}.`, file, projectRoot);

    expect(result.approved).toBe(true);
  });

  it("strips enclosing parens/comma from an unquoted @-marked candidate", async () => {
    const file = join(tempDir, "todo.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval(`(see @${file}), thanks`, file, projectRoot);

    expect(result.approved).toBe(true);
  });

  it("requires quoting when the path contains whitespace", async () => {
    const file = join(tempDir, "my notes.md");
    await writeFile(file, "content");

    // Unquoted mention of a path with an embedded space does not survive extraction as one token.
    const result = await checkPromptApproval(`check ${file} please`, file, projectRoot);

    expect(result.approved).toBe(false);
  });
});

describe("prefix collision", () => {
  it("does not approve a target that is a strict prefix of a mentioned path", async () => {
    const a = join(tempDir, "a");
    const ab = join(tempDir, "ab");
    await writeFile(a, "content");
    await writeFile(ab, "content");

    const result = await checkPromptApproval(`check ${ab}`, a, projectRoot);

    expect(result.approved).toBe(false);
  });
});

describe("symlink aliases", () => {
  it("approves when the prompt references a symlink resolving to the same real target", async () => {
    const real = join(tempDir, "real.md");
    const link = join(tempDir, "link.md");
    await writeFile(real, "content");
    await symlink(real, link);

    const result = await checkPromptApproval(`check ${link}`, real, projectRoot);

    expect(result.approved).toBe(true);
  });

  it("approves when the target path is the symlink and the prompt references the real path", async () => {
    const real = join(tempDir, "real.md");
    const link = join(tempDir, "link.md");
    await writeFile(real, "content");
    await symlink(real, link);

    const result = await checkPromptApproval(`check ${real}`, link, projectRoot);

    expect(result.approved).toBe(true);
  });
});

describe("no reference in prompt", () => {
  it("does not approve when the message never mentions the path", async () => {
    const file = join(tempDir, "todo.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval("what's the weather today?", file, projectRoot);

    expect(result.approved).toBe(false);
  });
});

describe("embedded @ is not a reference marker", () => {
  it("does not treat an @ embedded inside another token (email-like) as a marker", async () => {
    const dir = join(tempDir, "tmp");
    await mkdir(dir);

    // "admin@<dir>" — @ is preceded by "admin", not a boundary, so <dir> is never @-marked.
    const result = await checkPromptApproval(`contact admin@${dir} please`, dir, projectRoot);

    expect(result.approved).toBe(false);
  });
});

describe("non-regular filesystem nodes", () => {
  it.skipIf(process.platform === "win32")("never approves a device node such as /dev/null", async () => {
    const result = await checkPromptApproval("check @/dev/null please", "/dev/null", projectRoot);

    expect(result.approved).toBe(false);
    expect(result.isDirectory).toBe(false);
  });
});

describe("empty quotes", () => {
  it("does not approve from an empty quoted candidate", async () => {
    const file = join(tempDir, "todo.md");
    await writeFile(file, "content");

    const result = await checkPromptApproval(`check "" and ${file} unquoted`, file, projectRoot);

    // The empty quoted candidate contributes nothing; approval must come from the bare mention.
    expect(result.approved).toBe(true);
  });
});

describe("unmatched quotes fail closed", () => {
  it("does not approve a directory referenced via an unterminated quote", async () => {
    const dir = join(tempDir, "notes");
    await mkdir(dir);

    // No closing quote: the quoted-@ form never matches, and the leftover token
    // retains the leading quote character, so it cannot resolve to the directory.
    const result = await checkPromptApproval(`check @"${dir} please`, dir, projectRoot);

    expect(result.approved).toBe(false);
  });
});
