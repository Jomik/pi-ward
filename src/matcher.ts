import { relative } from "node:path";
import type { ParsedPattern, SegmentPattern } from "./pattern.js";

function matchesSegment(pattern: SegmentPattern, segment: string): boolean {
  switch (pattern.kind) {
    case "literal":
      return segment.toLowerCase() === pattern.value.toLowerCase();

    case "prefix":
      // segment must start with prefix and have at least 1 more char (for the `*`)
      return segment.toLowerCase().startsWith(pattern.prefix.toLowerCase()) && segment.length > pattern.prefix.length;

    case "suffix":
      // segment must end with suffix and have at least 1 more char (for the `*`)
      return segment.toLowerCase().endsWith(pattern.suffix.toLowerCase()) && segment.length > pattern.suffix.length;

    case "both":
      // segment must start with prefix, end with suffix, with at least 1 char in between
      return (
        segment.toLowerCase().startsWith(pattern.prefix.toLowerCase()) &&
        segment.toLowerCase().endsWith(pattern.suffix.toLowerCase()) &&
        segment.length > pattern.prefix.length + pattern.suffix.length
      );

    case "wildcard":
      // `*` matches one or more characters — any non-empty segment
      return segment.length > 0;
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

    if (pattern.directory) {
      // The relative path must have at least as many segments as the pattern,
      // and the first N must match.
      if (relSegments.length < pattern.segments.length) return false;
      return pattern.segments.every((seg, i) => {
        const relSeg = relSegments[i];
        return relSeg !== undefined && matchesSegment(seg, relSeg);
      });
    }

    // Non-directory anchored: relative path must have exactly N segments, all matching.
    if (relSegments.length !== pattern.segments.length) return false;
    return pattern.segments.every((seg, i) => {
      const relSeg = relSegments[i];
      return relSeg !== undefined && matchesSegment(seg, relSeg);
    });
  }

  // Unanchored: the pattern matches if ANY segment in the absolute path matches.
  const segPattern = pattern.segments[0];
  if (segPattern === undefined) return false;

  const segments = absolutePath.split("/").filter((s) => s !== "");
  return segments.some((seg) => matchesSegment(segPattern, seg));
}
