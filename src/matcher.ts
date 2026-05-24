import { relative } from "node:path";
import type { ParsedPattern, SegmentPattern } from "./pattern.js";

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

/**
 * Determine whether an absolute path matches a parsed pattern.
 *
 * @param pattern   - The parsed pattern to match against.
 * @param configDir - Absolute path to the directory the config governs
 *                    (used for anchored patterns).
 * @param absolutePath - The absolute path to test.
 */
export function matches(pattern: ParsedPattern, configDir: string, absolutePath: string): boolean {
  if (pattern.anchored) {
    const rel = relative(configDir, absolutePath);

    // Path is outside (or a sibling of) the config directory
    if (rel.startsWith("..")) return false;

    // Segments of the relative path; empty array when absolutePath === configDir
    const relSegments = rel === "" ? [] : rel.split("/").filter((s) => s !== "" && s !== ".");

    if (pattern.segments.length === 0) {
      // "./" alone — everything at or below the config dir
      return true;
    }

    // Directory: path must have >= N segments with first N matching.
    // Non-directory: path must have exactly N segments, all matching.
    if (pattern.directory) {
      if (relSegments.length < pattern.segments.length) return false;
    } else {
      if (relSegments.length !== pattern.segments.length) return false;
    }

    return pattern.segments.every((seg, i) => matchesSegment(seg, relSegments[i]));
  }

  // Unanchored: the pattern matches if ANY segment in the absolute path matches.
  const segPattern = pattern.segments[0];
  if (segPattern === undefined) return false;

  const segments = absolutePath.split("/").filter((s) => s !== "");
  return segments.some((seg) => matchesSegment(segPattern, seg));
}
