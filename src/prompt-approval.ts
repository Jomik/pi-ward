import { stat } from "node:fs/promises";
import { resolvePath } from "./resolve.js";
import { isDescendantOf } from "./walk.js";

/** Result of checking whether a prompt approves a resolved read target. */
export interface PromptApprovalResult {
  /** Whether the prompt text contains a reference resolving to the target path. */
  approved: boolean;
  /** Whether the target itself is a directory (relevant for recursive-tool integration). */
  isDirectory: boolean;
}

interface Candidate {
  /** Raw (unresolved) path text extracted from the prompt. */
  raw: string;
  /** Whether the candidate was `@`-marked. */
  marked: boolean;
}

// Matches, in priority order at each position: `@"quoted"`, `@bare`, `"quoted"`,
// and finally a bare unquoted token (any run of non-whitespace not claimed by
// one of the prior forms). The `@` forms only match at a reference boundary
// (start of message, whitespace, or an opening paren) so an `@` embedded
// inside another token (e.g. `admin@/tmp/dir`) is never treated as a marker.
const REFERENCE_REGEX = /(?<=^|[\s(])@"([^"]*)"|(?<=^|[\s(])@(\S+)|"([^"]*)"|(\S+)/g;

/** Strip prose punctuation not considered part of an unquoted path candidate. */
function stripBoundaryPunctuation(token: string): string {
  return token.replace(/^\(+/, "").replace(/[).,:]+$/, "");
}

/** Extract all candidate path references from a prompt message, per the reference grammar. */
function extractCandidates(message: string): Candidate[] {
  const candidates: Candidate[] = [];

  REFERENCE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = REFERENCE_REGEX.exec(message);
  while (match !== null) {
    if (match[1] !== undefined) {
      candidates.push({ raw: match[1], marked: true });
    } else if (match[2] !== undefined) {
      candidates.push({ raw: stripBoundaryPunctuation(match[2]), marked: true });
    } else if (match[3] !== undefined) {
      candidates.push({ raw: match[3], marked: false });
    } else if (match[4] !== undefined) {
      candidates.push({ raw: stripBoundaryPunctuation(match[4]), marked: false });
    }
    match = REFERENCE_REGEX.exec(message);
  }

  return candidates;
}

/** Determine what kind of filesystem entry a resolved path is, without throwing. */
async function targetKind(resolvedPath: string): Promise<"file" | "directory" | "other" | "missing"> {
  try {
    const s = await stat(resolvedPath);
    if (s.isFile()) return "file";
    if (s.isDirectory()) return "directory";
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Decide whether prompt text approves a resolved read target, per the
 * prompt-derived approval reference grammar:
 * - Existing regular files qualify whether bare or `@`-marked.
 * - Existing directories qualify only when `@`-marked.
 * - Missing/unresolvable targets never qualify.
 * - An `@`-marked candidate that resolves to an existing directory also
 *   approves any existing canonical descendant of that directory (not just
 *   the directory itself). A bare directory candidate never authorizes
 *   descendants. A marked candidate that resolves to a file never creates
 *   subtree access.
 *
 * Each prompt candidate and the target are resolved independently against
 * projectRoot; exact-match approval requires canonical-path equality, and
 * subtree approval requires the target to be a canonical descendant of the
 * marked directory candidate.
 */
export async function checkPromptApproval(
  promptText: string,
  targetPath: string,
  projectRoot: string,
  homeDir?: string,
): Promise<PromptApprovalResult> {
  const target = await resolvePath(targetPath, projectRoot, homeDir);
  if (target.denied) return { approved: false, isDirectory: false };

  const kind = await targetKind(target.path);
  if (kind === "missing" || kind === "other") return { approved: false, isDirectory: false };
  const isDirectory = kind === "directory";

  for (const candidate of extractCandidates(promptText)) {
    if (!candidate.raw) continue;

    const resolved = await resolvePath(candidate.raw, projectRoot, homeDir);
    if (resolved.denied) continue;

    if (resolved.path === target.path) {
      if (isDirectory && !candidate.marked) continue;
      return { approved: true, isDirectory };
    }

    if (candidate.marked && isDescendantOf(resolved.path, target.path)) {
      const candidateKind = await targetKind(resolved.path);
      if (candidateKind === "directory") {
        return { approved: true, isDirectory };
      }
    }
  }

  return { approved: false, isDirectory };
}
