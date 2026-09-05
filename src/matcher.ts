import { relative } from "node:path";
import type { ParsedPattern, SegmentPattern } from "./pattern.js";
import { isDescendantOf } from "./walk.js";

function matchesSegment(pattern: SegmentPattern, segment: string): boolean {
  const seg = segment.toLowerCase();
  switch (pattern.kind) {
    case "literal":
      return seg === pattern.value.toLowerCase();

    case "prefix":
      // segment must start with prefix and have at least 1 more char (for the `*`)
      return seg.startsWith(pattern.prefix.toLowerCase()) && seg.length > pattern.prefix.length;

    case "suffix":
      // segment must end with suffix and have at least 1 more char (for the `*`)
      return seg.endsWith(pattern.suffix.toLowerCase()) && seg.length > pattern.suffix.length;

    case "both":
      // segment must start with prefix, end with suffix, with at least 1 char in between
      return (
        seg.startsWith(pattern.prefix.toLowerCase()) &&
        seg.endsWith(pattern.suffix.toLowerCase()) &&
        seg.length > pattern.prefix.length + pattern.suffix.length
      );

    case "wildcard":
      // `*` matches one or more characters — any non-empty segment
      return seg.length > 0;
  }
}

function matchesAnchored(pattern: ParsedPattern, configDir: string, absolutePath: string): boolean {
  const rel = relative(configDir, absolutePath);
  if (!isDescendantOf(configDir, absolutePath)) return false;

  // Segments of the relative path; empty array when absolutePath === configDir
  const relSegments = rel === "" ? [] : rel.split(/[/\\]/).filter((s) => s !== "" && s !== ".");

  if (pattern.segments.length === 0) return true;

  const lengthOk = pattern.directory
    ? relSegments.length >= pattern.segments.length
    : relSegments.length === pattern.segments.length;
  if (!lengthOk) return false;

  return pattern.segments.every((seg, i) => matchesSegment(seg, relSegments[i]));
}

/**
 * Determine whether an absolute path matches a parsed pattern.
 *
 * @param pattern   - The parsed pattern to match against.
 * @param configDir - Absolute path to the directory the config governs
 *                    (used for anchored patterns).
 * @param absolutePath - The absolute path to test.
 * @param homeDir   - Absolute path to the user's home directory
 *                    (used for home-anchored patterns).
 */
export function matches(pattern: ParsedPattern, configDir: string, absolutePath: string, homeDir?: string): boolean {
  if (pattern.anchored) return matchesAnchored(pattern, configDir, absolutePath);
  if (pattern.absoluteAnchored) return matchesAnchored(pattern, "/", absolutePath);
  if (pattern.homeAnchored) {
    if (homeDir === undefined) {
      throw new Error("matches: homeDir is required for home-anchored patterns");
    }
    return matchesAnchored(pattern, homeDir, absolutePath);
  }

  // Unanchored: single-segment patterns match if ANY segment in the absolute path matches.
  // Multi-segment patterns match a contiguous run of segments:
  //   - directory (trailing `/`): the run may occur anywhere in the path, matching the
  //     node itself and all descendants.
  //   - non-directory: the run must occur only at the very end of the path (the terminal
  //     node), never with additional trailing segments.
  const segments = absolutePath.split(/[/\\]/).filter((s) => s !== "");
  const patSegments = pattern.segments;
  if (patSegments.length === 0) return false;

  if (patSegments.length === 1) {
    const segPattern = patSegments[0];
    return segments.some((seg) => matchesSegment(segPattern, seg));
  }

  if (pattern.directory) {
    for (let start = 0; start + patSegments.length <= segments.length; start++) {
      if (patSegments.every((sp, i) => matchesSegment(sp, segments[start + i]))) return true;
    }
    return false;
  }

  if (segments.length < patSegments.length) return false;
  const start = segments.length - patSegments.length;
  return patSegments.every((sp, i) => matchesSegment(sp, segments[start + i]));
}
