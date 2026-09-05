import { describe, expect, it } from "vitest";
import { parsePattern } from "../src/pattern.js";

describe("parsePattern", () => {
  describe("unanchored literal", () => {
    it("parses a simple literal segment", () => {
      const p = parsePattern(".env");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "literal", value: ".env" }],
      });
    });

    it("parses a literal with trailing slash (directory)", () => {
      const p = parsePattern(".secret/");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: true,
        segments: [{ kind: "literal", value: ".secret" }],
      });
    });
  });

  describe("unanchored wildcard segments", () => {
    it("parses prefix wildcard (.env*)", () => {
      const p = parsePattern(".env*");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "prefix", prefix: ".env" }],
      });
    });

    it("parses suffix wildcard (*.pem)", () => {
      const p = parsePattern("*.pem");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "suffix", suffix: ".pem" }],
      });
    });

    it("parses bare wildcard (*)", () => {
      const p = parsePattern("*");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "wildcard" }],
      });
    });

    it("parses both-side wildcard (foo*.ext)", () => {
      const p = parsePattern("foo*.ext");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "both", prefix: "foo", suffix: ".ext" }],
      });
    });
  });

  describe("unanchored multi-segment patterns", () => {
    it("parses '.pi/PLAN.md' (multi-segment unanchored, non-directory)", () => {
      const p = parsePattern(".pi/PLAN.md");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [
          { kind: "literal", value: ".pi" },
          { kind: "literal", value: "PLAN.md" },
        ],
      });
    });

    it("parses '.pi/' (multi-segment unanchored directory)", () => {
      const p = parsePattern(".pi/");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: true,
        segments: [{ kind: "literal", value: ".pi" }],
      });
    });

    it("parses '.pi/*.md' (wildcard within a segment of a multi-segment unanchored pattern)", () => {
      const p = parsePattern(".pi/*.md");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [
          { kind: "literal", value: ".pi" },
          { kind: "suffix", suffix: ".md" },
        ],
      });
    });

    it("throws for empty interior segment (.pi//PLAN.md)", () => {
      expect(() => parsePattern(".pi//PLAN.md")).toThrow(/empty segment/);
    });

    it("throws for multiple wildcards in a single segment of a multi-segment pattern", () => {
      expect(() => parsePattern(".pi/foo*bar*baz")).toThrow();
    });
  });

  describe("anchored patterns", () => {
    it("parses './' (everything at/below config dir)", () => {
      const p = parsePattern("./");
      expect(p).toEqual({
        anchored: true,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: true,
        segments: [],
      });
    });

    it("parses './.secret/' (anchored directory)", () => {
      const p = parsePattern("./.secret/");
      expect(p).toEqual({
        anchored: true,
        homeAnchored: false,
        absoluteAnchored: false,
        directory: true,
        segments: [{ kind: "literal", value: ".secret" }],
      });
    });

    it("parses './src/*.ts' (multi-segment anchored)", () => {
      const p = parsePattern("./src/*.ts");
      expect(p).toEqual({
        anchored: true,
        homeAnchored: false,
        absoluteAnchored: false,
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
        homeAnchored: false,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "literal", value: "src" }],
      });
    });
  });

  describe("home-anchored patterns", () => {
    it("parses '~/' (everything at/below home dir)", () => {
      const p = parsePattern("~/");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: true,
        absoluteAnchored: false,
        directory: true,
        segments: [],
      });
    });

    it("parses '~/.ssh/' (home-anchored directory)", () => {
      const p = parsePattern("~/.ssh/");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: true,
        absoluteAnchored: false,
        directory: true,
        segments: [{ kind: "literal", value: ".ssh" }],
      });
    });

    it("~/  prefix is parsed as homeAnchored: true and anchored: false", () => {
      const p = parsePattern("~/.ssh/");
      expect(p.homeAnchored).toBe(true);
      expect(p.anchored).toBe(false);
    });

    it("parses '~/.pi/agent/skills/' → homeAnchored multi-segment directory", () => {
      const p = parsePattern("~/.pi/agent/skills/");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: true,
        absoluteAnchored: false,
        directory: true,
        segments: [
          { kind: "literal", value: ".pi" },
          { kind: "literal", value: "agent" },
          { kind: "literal", value: "skills" },
        ],
      });
    });

    it("parses '~/projects/*.ts' (multi-segment home-anchored)", () => {
      const p = parsePattern("~/projects/*.ts");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: true,
        absoluteAnchored: false,
        directory: false,
        segments: [
          { kind: "literal", value: "projects" },
          { kind: "suffix", suffix: ".ts" },
        ],
      });
    });

    it("parses '~/file.txt' → homeAnchored non-directory", () => {
      const p = parsePattern("~/file.txt");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: true,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "literal", value: "file.txt" }],
      });
    });

    it("parses '~/docs' (home-anchored single segment, no trailing slash)", () => {
      const p = parsePattern("~/docs");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: true,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "literal", value: "docs" }],
      });
    });

    it("parses '~/*.pem' → homeAnchored suffix wildcard", () => {
      const p = parsePattern("~/*.pem");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: true,
        absoluteAnchored: false,
        directory: false,
        segments: [{ kind: "suffix", suffix: ".pem" }],
      });
    });
  });

  describe("absolute-anchored patterns", () => {
    it("parses '/tmp/foo/' (directory)", () => {
      const p = parsePattern("/tmp/foo/");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: true,
        directory: true,
        segments: [
          { kind: "literal", value: "tmp" },
          { kind: "literal", value: "foo" },
        ],
      });
    });

    it("parses '/tmp/*.log' (non-directory with wildcard)", () => {
      const p = parsePattern("/tmp/*.log");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: true,
        directory: false,
        segments: [
          { kind: "literal", value: "tmp" },
          { kind: "suffix", suffix: ".log" },
        ],
      });
    });

    it("parses '/tmp/foo' (non-directory)", () => {
      const p = parsePattern("/tmp/foo");
      expect(p).toEqual({
        anchored: false,
        homeAnchored: false,
        absoluteAnchored: true,
        directory: false,
        segments: [
          { kind: "literal", value: "tmp" },
          { kind: "literal", value: "foo" },
        ],
      });
    });

    it("throws for bare '/' (invalid)", () => {
      expect(() => parsePattern("/")).toThrow(/must specify a path/);
    });

    it("throws for '//' (empty body after stripping)", () => {
      expect(() => parsePattern("//")).toThrow(/must specify a path/);
    });

    it("throws for '/tmp/../etc' (dot-dot segment)", () => {
      expect(() => parsePattern("/tmp/../etc")).toThrow(/"." and ".." segments are not allowed/);
    });

    it("throws for '/./tmp' (dot segment)", () => {
      expect(() => parsePattern("/./tmp")).toThrow(/"." and ".." segments are not allowed/);
    });

    it("throws for empty segment in absolute-anchored pattern (/tmp//foo)", () => {
      expect(() => parsePattern("/tmp//foo")).toThrow(/empty segment/);
    });
  });

  describe("invalid patterns", () => {
    it("throws for '**/*.ts' (double wildcard)", () => {
      expect(() => parsePattern("**/*.ts")).toThrow();
    });

    it("throws for '{a,b}' (braces)", () => {
      expect(() => parsePattern("{a,b}")).toThrow();
    });

    it("throws for 'foo}' (closing brace without opening)", () => {
      expect(() => parsePattern("foo}")).toThrow();
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

    it("throws for empty segment in unanchored multi-segment pattern (double slash)", () => {
      expect(() => parsePattern("src//.env")).toThrow(/empty segment/);
    });

    it("throws for bare '~' (likely typo for '~/')", () => {
      expect(() => parsePattern("~")).toThrow(/Did you mean/);
    });

    it("throws for '~foo' (tilde without slash)", () => {
      expect(() => parsePattern("~foo")).toThrow(/Did you mean/);
    });

    it("throws for '~~' (double tilde)", () => {
      expect(() => parsePattern("~~")).toThrow(/Did you mean/);
    });

    it("throws for '~//' (double slash after ~/)", () => {
      expect(() => parsePattern("~//")).toThrow(/not a valid pattern/);
    });

    it("throws for './/' (double slash after ./)", () => {
      expect(() => parsePattern(".//")).toThrow(/not a valid pattern/);
    });
  });
});
