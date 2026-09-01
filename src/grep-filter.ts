import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GrantStore } from "./grants.js";
import { checkPath } from "./guard.js";
import type { ParsedRule } from "./rules.js";

/**
 * Regex to find ALL potential split points in a grep output line.
 *
 * A split point is any position where the pattern `sep digits sep space` occurs,
 * where sep is `:` or `-` and the SAME sep appears on both sides.
 *
 * Format produced by pi's grep tool:
 *   match line:   relativePath:LINENUM: text
 *   context line: relativePath-LINENUM- text
 *
 * Each match index gives the end-of-path position: everything before the match
 * is a candidate relativePath.
 *
 * Using a global regex; reset lastIndex before each line.
 */
const SPLIT_RE = /([:-])(\d+)\1 /g;

export interface FilterGrepOutputResult {
  /** Filtered output text (denied lines removed, note appended if any removed). */
  text: string;
  /** Number of lines removed because their source file was denied by policy. */
  dropped: number;
  /** Number of distinct denied source files. */
  files: number;
  /** True if the output text differs from the input text (lines dropped or note added). */
  changed: boolean;
}

/**
 * Filter grep output text, removing lines whose source file is denied by the
 * current access rules.
 *
 * Algorithm (filesystem-verified, deny-wins, fail-closed):
 *
 * For each output line:
 * 1. Find ALL split points: positions where `([:-])(\d+)\1 ` matches. Each
 *    yields a candidate relativePath (substring before the match).
 * 2. Resolve each candidate to an absolute path and stat() to verify it is a
 *    real regular file. Results are cached per absPath.
 * 3. Decide:
 *    - No split points, or no candidate resolves to a real file → DROP the line
 *      (fail-closed / unattributable). Not counted as a policy denial.
 *    - ≥1 real file found: run checkPath for each. KEEP only if ALL are allowed.
 *      If ANY is denied → DROP and count as policy denial (deny-wins).
 * 4. Build output text from kept lines; append note only when policy denials > 0.
 *
 * @param text        Raw grep output text (single text part content).
 * @param searchRoot  Absolute directory used as grep's search root. When grep
 *                    ran on a single file, caller should pass dirname(file) so
 *                    that the basename-only path grep emits resolves correctly.
 * @param rules       Parsed access rules.
 * @param projectRoot Absolute project root path.
 * @param grants      Optional session grant store.
 * @param approvedRoot Optional call-scoped root approved for this grep call
 *                     (e.g. a prompt-approved directory). Descendant regular
 *                     files under this root pass the baseline outside-project
 *                     deny, but explicit rule denies and session denies still
 *                     win. Scope is limited to this single filtering pass —
 *                     callers must not persist it across calls.
 *
 *
 * **TOCTOU limitation:** this filter stat-verifies candidate paths *after* grep
 * has already run. Its guarantee — that a denied file's matched line is never
 * surfaced — holds only when filesystem state is stable between grep execution
 * and filtering. If a denied file is deleted between grep and filter while a
 * same-prefix allowed file exists, a line could be misattributed and kept. This
 * is an inherent property of post-hoc output filtering and is an accepted
 * limitation.
 */
export async function filterGrepOutput(
  text: string,
  searchRoot: string,
  rules: ParsedRule[],
  projectRoot: string,
  grants?: GrantStore,
  approvedRoot?: string,
): Promise<FilterGrepOutputResult> {
  const lines = text.split("\n");

  // Cache: absPath → whether the path exists as a regular file on disk.
  const existsCache = new Map<string, boolean>();
  // Cache: absPath → whether access is allowed by policy.
  const allowCache = new Map<string, boolean>();

  const keptLines: string[] = [];
  let dropped = 0;
  const deniedFiles = new Set<string>();

  /** Return true if absPath is a regular file (cached). */
  async function fileExists(absPath: string): Promise<boolean> {
    if (existsCache.has(absPath)) {
      // biome-ignore lint/style/noNonNullAssertion: cache.has guarantees presence
      return existsCache.get(absPath)!;
    }
    try {
      const s = await stat(absPath);
      const exists = s.isFile();
      existsCache.set(absPath, exists);
      return exists;
    } catch {
      existsCache.set(absPath, false);
      return false;
    }
  }

  /** Return true if access to absPath is allowed by policy (cached). */
  async function isAllowed(absPath: string): Promise<boolean> {
    if (allowCache.has(absPath)) {
      // biome-ignore lint/style/noNonNullAssertion: cache.has guarantees presence
      return allowCache.get(absPath)!;
    }
    const result = await checkPath("grep", absPath, "read", rules, projectRoot, grants, approvedRoot);
    allowCache.set(absPath, result.allowed);
    return result.allowed;
  }

  for (const line of lines) {
    // Empty lines (e.g. trailing newline after split) carry no content and have
    // no split point. Preserve them unchanged so trailing newlines are not lost
    // and `changed` stays false when no real filtering occurred.
    if (line === "") {
      keptLines.push(line);
      continue;
    }

    // --- Step 1: collect all candidate paths from split points ---------------
    SPLIT_RE.lastIndex = 0;
    const candidateAbsPaths: string[] = [];
    for (const m of line.matchAll(SPLIT_RE)) {
      const candidate = line.substring(0, m.index);
      candidateAbsPaths.push(resolve(searchRoot, candidate));
    }

    if (candidateAbsPaths.length === 0) {
      // No split point at all → unattributable, drop (fail-closed).
      // Not a policy denial; do not count toward `dropped` or `files`.
      continue;
    }

    // --- Step 2: keep only candidates that are real files on disk ------------
    const realCandidates: string[] = [];
    for (const absPath of candidateAbsPaths) {
      if (await fileExists(absPath)) {
        realCandidates.push(absPath);
      }
    }

    if (realCandidates.length === 0) {
      // Split points exist but no candidate is a real file → unattributable.
      // Drop fail-closed; not counted as a policy denial.
      continue;
    }

    // --- Step 3: policy check — deny-wins across all real candidates ---------
    let lineAllowed = true;
    for (const absPath of realCandidates) {
      if (!(await isAllowed(absPath))) {
        lineAllowed = false;
        deniedFiles.add(absPath);
      }
    }

    if (lineAllowed) {
      keptLines.push(line);
    } else {
      dropped++;
    }
  }

  // --- Step 4: build output text -------------------------------------------
  let resultText = keptLines.join("\n");

  if (dropped > 0) {
    const matchWord = dropped === 1 ? "match" : "matches";
    const fileWord = deniedFiles.size === 1 ? "file" : "files";
    const note = `[pi-ward] ${dropped} ${matchWord} in ${deniedFiles.size} protected ${fileWord} hidden`;
    resultText = resultText ? `${resultText}\n${note}` : note;
  }

  return {
    text: resultText,
    dropped,
    files: deniedFiles.size,
    changed: resultText !== text,
  };
}
