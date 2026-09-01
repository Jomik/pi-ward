import { stat } from "node:fs/promises";
import { resolvePath } from "./resolve.js";

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

// Matches, in priority order at each position: `@"quoted"`, `@bare`, `"quoted"`.
// Bare unquoted tokens (not matched here) are recovered from the remaining text.
const REFERENCE_REGEX = /@"([^"]*)"|@(\S+)|"([^"]*)"/g;

/** Strip prose punctuation not considered part of an unquoted path candidate. */
function stripBoundaryPunctuation(token: string): string {
  return token.replace(/^\(+/, "").replace(/[).,:]+$/, "");
}

/** Extract all candidate path references from a prompt message, per the reference grammar. */
function extractCandidates(message: string): Candidate[] {
  const candidates: Candidate[] = [];
  const consumed: Array<[number, number]> = [];

  REFERENCE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = REFERENCE_REGEX.exec(message);
  while (match !== null) {
    consumed.push([match.index, match.index + match[0].length]);
    if (match[1] !== undefined) {
      candidates.push({ raw: match[1], marked: true });
    } else if (match[2] !== undefined) {
      candidates.push({ raw: stripBoundaryPunctuation(match[2]), marked: true });
    } else if (match[3] !== undefined) {
      candidates.push({ raw: match[3], marked: false });
    }
    match = REFERENCE_REGEX.exec(message);
  }

  // Recover bare unquoted tokens from the text outside already-consumed spans.
  let remainder = "";
  let cursor = 0;
  for (const [start, end] of consumed) {
    remainder += `${message.slice(cursor, start)} `;
    cursor = end;
  }
  remainder += message.slice(cursor);

  for (const token of remainder.split(/\s+/)) {
    if (!token) continue;
    const stripped = stripBoundaryPunctuation(token);
    if (!stripped) continue;
    candidates.push({ raw: stripped, marked: false });
  }

  return candidates;
}

/** Determine what kind of filesystem entry a resolved path is, without throwing. */
async function targetKind(resolvedPath: string): Promise<"file" | "directory" | "missing"> {
  try {
    const s = await stat(resolvedPath);
    return s.isDirectory() ? "directory" : "file";
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
 *
 * Each prompt candidate and the target are resolved independently against
 * projectRoot; approval requires canonical-path equality.
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
  if (kind === "missing") return { approved: false, isDirectory: false };
  const isDirectory = kind === "directory";

  for (const candidate of extractCandidates(promptText)) {
    if (!candidate.raw) continue;
    if (isDirectory && !candidate.marked) continue;

    const resolved = await resolvePath(candidate.raw, projectRoot, homeDir);
    if (resolved.denied) continue;
    if (resolved.path === target.path) {
      return { approved: true, isDirectory };
    }
  }

  return { approved: false, isDirectory };
}
