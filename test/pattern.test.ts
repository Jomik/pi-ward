import { describe, expect, it } from "vitest";
import { parsePattern } from "../src/pattern.js";

describe("parsePattern", () => {
  describe("unanchored literal", () => {
    it("parses a simple literal segment", () => {
      const p = parsePattern(".env");
      expect(p).toEqual({ anchored: false, directory: false, segments: [{ kind: "literal", value: ".env" }] });
    });

    it("parses a literal with trailing slash (directory)", () => {
      const p = parsePattern(".secret/");
      expect(p).toEqual({ anchored: false, directory: true, segments: [{ kind: "literal", value: ".secret" }] });
    });
  });

  describe("unanchored wildcard segments", () => {
    it("parses prefix wildcard (.env*)", () => {
      const p = parsePattern(".env*");
      expect(p).toEqual({ anchored: false, directory: false, segments: [{ kind: "prefix", prefix: ".env" }] });
    });

    it("parses suffix wildcard (*.pem)", () => {
      const p = parsePattern("*.pem");
      expect(p).toEqual({ anchored: false, directory: false, segments: [{ kind: "suffix", suffix: ".pem" }] });
    });

    it("parses bare wildcard (*)", () => {
      const p = parsePattern("*");
      expect(p).toEqual({ anchored: false, directory: false, segments: [{ kind: "wildcard" }] });
    });

    it("parses both-side wildcard (foo*.ext)", () => {
      const p = parsePattern("foo*.ext");
      expect(p).toEqual({
        anchored: false,
        directory: false,
        segments: [{ kind: "both", prefix: "foo", suffix: ".ext" }],
      });
    });
  });

  describe("anchored patterns", () => {
    it("parses './' (everything at/below config dir)", () => {
      const p = parsePattern("./");
      expect(p).toEqual({ anchored: true, directory: true, segments: [] });
    });

    it("parses './.secret/' (anchored directory)", () => {
      const p = parsePattern("./.secret/");
      expect(p).toEqual({
        anchored: true,
        directory: true,
        segments: [{ kind: "literal", value: ".secret" }],
      });
    });

    it("parses './src/*.ts' (multi-segment anchored)", () => {
      const p = parsePattern("./src/*.ts");
      expect(p).toEqual({
        anchored: true,
        directory: false,
        segments: [
          { kind: "literal", value: "src" },
          { kind: "suffix", suffix: ".ts" },
        ],
      });
    });

    it("parses './src' (anchored single segment, no trailing slash)", () => {
      const p = parsePattern("./src");
      expect(p).toEqual({
        anchored: true,
        directory: false,
        segments: [{ kind: "literal", value: "src" }],
      });
    });
  });

  describe("invalid patterns", () => {
    it("throws for unanchored pattern containing '/'", () => {
      expect(() => parsePattern("src/.env")).toThrow();
    });

    it("throws for '**/*.ts' (double wildcard)", () => {
      expect(() => parsePattern("**/*.ts")).toThrow();
    });

    it("throws for '{a,b}' (braces)", () => {
      expect(() => parsePattern("{a,b}")).toThrow();
    });

    it("throws for empty pattern", () => {
      expect(() => parsePattern("")).toThrow();
    });

    it("throws for multiple wildcards in a single segment", () => {
      expect(() => parsePattern("foo*bar*baz")).toThrow();
    });

    it("throws for empty segment in anchored pattern (double slash)", () => {
      expect(() => parsePattern("./src//file.ts")).toThrow();
    });
  });
});
