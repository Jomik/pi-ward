/**
 * Describes how to match a single path segment.
 * `*` matches one or more characters within the segment (never crosses `/`).
 */
export type SegmentPattern =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "suffix"; readonly suffix: string }
  | { readonly kind: "both"; readonly prefix: string; readonly suffix: string }
  | { readonly kind: "wildcard" };

/**
 * Parsed representation of a ward pattern string.
 */
export interface ParsedPattern {
  /** True if the pattern starts with "./" (anchored to the config directory). */
  readonly anchored: boolean;
  /** True if the pattern starts with "~/" (anchored to the home directory). */
  readonly homeAnchored: boolean;
  /** True if the pattern starts with "/" (anchored to the filesystem root). */
  readonly absoluteAnchored: boolean;
  /** True if the pattern ends with "/" (directory match). */
  readonly directory: boolean;
  /**
   * Segment patterns.
   * - Unanchored: always one element.
   * - `./`-anchored with empty array: matches everything at/below the config dir.
   * - `~/`-home-anchored with empty array: matches everything at/below the home dir.
   * - `./`-anchored or `~/`-home-anchored non-empty: each element corresponds to a path segment
   *   relative to the respective anchor directory.
   */
  readonly segments: ReadonlyArray<SegmentPattern>;
}

function parseSegmentPattern(seg: string, rawPattern: string): SegmentPattern {
  if (seg === "") {
    throw new Error(`Invalid pattern: empty segment in "${rawPattern}"`);
  }

  const starCount = (seg.match(/\*/g) ?? []).length;

  if (starCount === 0) {
    return { kind: "literal", value: seg };
  }

  if (starCount === 1) {
    if (seg === "*") return { kind: "wildcard" };

    const starIdx = seg.indexOf("*");

    if (starIdx === 0) {
      // *.ext — suffix wildcard
      return { kind: "suffix", suffix: seg.slice(1) };
    }

    if (starIdx === seg.length - 1) {
      // foo* — prefix wildcard
      return { kind: "prefix", prefix: seg.slice(0, -1) };
    }

    // foo*.ext — both
    return {
      kind: "both",
      prefix: seg.slice(0, starIdx),
      suffix: seg.slice(starIdx + 1),
    };
  }

  throw new Error(`Invalid pattern: multiple wildcards in a single segment are not supported: "${rawPattern}"`);
}

function parseAnchored(body: string, directory: boolean, raw: string): ParsedPattern {
  if (body === "") {
    return { anchored: true, homeAnchored: false, absoluteAnchored: false, directory, segments: [] };
  }
  const segments = body.split("/").map((part) => parseSegmentPattern(part, raw));
  return { anchored: true, homeAnchored: false, absoluteAnchored: false, directory, segments };
}

function parseHomeAnchored(body: string, directory: boolean, raw: string): ParsedPattern {
  if (body === "") {
    return { anchored: false, homeAnchored: true, absoluteAnchored: false, directory, segments: [] };
  }
  const segments = body.split("/").map((part) => parseSegmentPattern(part, raw));
  return { anchored: false, homeAnchored: true, absoluteAnchored: false, directory, segments };
}

function parseAbsoluteAnchored(body: string, directory: boolean, raw: string): ParsedPattern {
  if (body === "") {
    throw new Error(`Invalid pattern: absolute-anchored pattern must specify a path: "${raw}"`);
  }
  const parts = body.split("/");
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error(`Invalid pattern: "." and ".." segments are not allowed in absolute-anchored patterns: "${raw}"`);
    }
  }
  const segments = parts.map((part) => parseSegmentPattern(part, raw));
  return { anchored: false, homeAnchored: false, absoluteAnchored: true, directory, segments };
}

function parseUnanchored(body: string, directory: boolean, raw: string): ParsedPattern {
  if (body === "") {
    throw new Error(`Invalid pattern: empty pattern "${raw}"`);
  }
  if (body.includes("/")) {
    throw new Error(
      `Invalid pattern: unanchored pattern cannot contain "/": "${raw}". Use "./" or "~/" prefix for multi-segment patterns.`,
    );
  }
  const segment = parseSegmentPattern(body, raw);
  return { anchored: false, homeAnchored: false, absoluteAnchored: false, directory, segments: [segment] };
}

/**
 * Parse a pattern string into a structured ParsedPattern.
 *
 * Syntax rules:
 * - No prefix → unanchored single-segment pattern. Must not contain `/`.
 * - `./` prefix → anchored to the config directory. May contain `/`.
 * - `~/` prefix → anchored to the home directory. May contain `/`.
 * - `/` prefix → anchored to the filesystem root. May contain `/`.
 * - Trailing `/` → directory match (the node itself and everything under it).
 * - `*` → matches one or more characters within a segment (not `/`).
 * - No `**`, braces, extglobs, or regex.
 *
 * @throws on invalid syntax.
 */
export function parsePattern(raw: string): ParsedPattern {
  if (raw.includes("**")) {
    throw new Error(`Invalid pattern: "**" is not supported: "${raw}"`);
  }
  if (raw.includes("{")) {
    throw new Error(`Invalid pattern: braces are not supported: "${raw}"`);
  }
  if (raw.includes("}")) {
    throw new Error(`Invalid pattern: braces are not supported: "${raw}"`);
  }

  const anchored = raw.startsWith("./");
  const homeAnchored = !anchored && raw.startsWith("~/");
  const absoluteAnchored = !anchored && !homeAnchored && raw.startsWith("/");
  const directory = raw.endsWith("/");

  // Catch bare `~` or `~foo` — likely a typo for `~/` or `~/foo`.
  if (!anchored && !homeAnchored && !absoluteAnchored && raw.startsWith("~")) {
    throw new Error(
      `Invalid pattern: "${raw}" starts with "~" but is not home-anchored. Did you mean "~/${raw.slice(1)}"?`,
    );
  }

  let inner = raw;
  if (anchored || homeAnchored) inner = inner.slice(2);
  else if (absoluteAnchored) inner = inner.slice(1);
  if (directory) inner = inner.slice(0, -1);

  // Reject patterns like "~//" or ".//" that normalize to empty but aren't the canonical "~/" or "./".
  if ((anchored || homeAnchored) && inner === "" && raw !== "./" && raw !== "~/") {
    throw new Error(`Invalid pattern: "${raw}" is not a valid pattern. Did you mean "${raw.slice(0, 2)}"?`);
  }

  if (anchored) return parseAnchored(inner, directory, raw);
  if (homeAnchored) return parseHomeAnchored(inner, directory, raw);
  if (absoluteAnchored) return parseAbsoluteAnchored(inner, directory, raw);
  return parseUnanchored(inner, directory, raw);
}
