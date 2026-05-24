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
  /** True if the pattern ends with "/" (directory match). */
  readonly directory: boolean;
  /**
   * Segment patterns.
   * - Unanchored: always one element.
   * - Anchored with empty array: matches everything at/below the config dir (`./`).
   * - Anchored non-empty: each element corresponds to a path segment relative to the config dir.
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
    return { anchored: true, directory: true, segments: [] };
  }
  const segments = body.split("/").map((part) => parseSegmentPattern(part, raw));
  return { anchored: true, directory, segments };
}

function parseUnanchored(body: string, directory: boolean, raw: string): ParsedPattern {
  if (body === "") {
    throw new Error(`Invalid pattern: empty pattern "${raw}"`);
  }
  if (body.includes("/")) {
    throw new Error(
      `Invalid pattern: unanchored pattern cannot contain "/": "${raw}". Use a "./" prefix for multi-segment patterns.`,
    );
  }
  const segment = parseSegmentPattern(body, raw);
  return { anchored: false, directory, segments: [segment] };
}

/**
 * Parse a pattern string into a structured ParsedPattern.
 *
 * Syntax rules:
 * - No prefix → unanchored single-segment pattern. Must not contain `/`.
 * - `./` prefix → anchored to the config directory. May contain `/`.
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
  const directory = raw.endsWith("/");

  let inner = raw;
  if (anchored) inner = inner.slice(2);
  if (directory) inner = inner.slice(0, -1);

  return anchored ? parseAnchored(inner, directory, raw) : parseUnanchored(inner, directory, raw);
}
