import { describe, expect, it } from "vitest";
import { matches } from "../src/matcher.js";
import { parsePattern } from "../src/pattern.js";

const CONFIG_DIR = "/home/user/project";

/** Helper: parse and match in one call */
function m(pattern: string, absolutePath: string, configDir = CONFIG_DIR): boolean {
  return matches(parsePattern(pattern), configDir, absolutePath);
}

describe("matches — DESIGN.md table examples", () => {
  describe("`.env` — unanchored literal", () => {
    it("matches a path whose last segment is .env", () => {
      expect(m(".env", "/base/.env")).toBe(true);
    });

    it("matches .env nested under a directory", () => {
      expect(m(".env", "/base/src/.env")).toBe(true);
    });

    it("matches a path that continues below .env", () => {
      expect(m(".env", "/base/.env/secrets")).toBe(true);
    });

    it("does not match .env.local", () => {
      expect(m(".env", "/base/.env.local")).toBe(false);
    });
  });

  describe("`.env*` — unanchored prefix wildcard", () => {
    it("matches .env.local", () => {
      expect(m(".env*", "/base/.env.local")).toBe(true);
    });

    it("matches .env.production nested under a directory", () => {
      expect(m(".env*", "/base/foo/.env.production")).toBe(true);
    });

    it("does not match 'env' (missing leading dot)", () => {
      expect(m(".env*", "/base/env")).toBe(false);
    });

    it("does not match 'myenv' (does not start with .env)", () => {
      expect(m(".env*", "/base/myenv")).toBe(false);
    });

    it("does not match '.env' itself (wildcard requires 1+ extra chars)", () => {
      expect(m(".env*", "/base/.env")).toBe(false);
    });
  });

  describe("`*.pem` — unanchored suffix wildcard", () => {
    it("matches cert.pem", () => {
      expect(m("*.pem", "/base/cert.pem")).toBe(true);
    });

    it("matches key.pem nested deeply", () => {
      expect(m("*.pem", "/base/foo/bar/key.pem")).toBe(true);
    });

    it("does not match bare 'pem' (no prefix for wildcard)", () => {
      expect(m("*.pem", "/base/pem")).toBe(false);
    });

    it("does not match cert.pem.bak (does not end with .pem)", () => {
      expect(m("*.pem", "/base/cert.pem.bak")).toBe(false);
    });

    it("does not match '.pem' itself (wildcard requires 1+ extra chars)", () => {
      expect(m("*.pem", "/base/.pem")).toBe(false);
    });
  });

  describe("`*` — bare wildcard", () => {
    it("matches any non-empty segment", () => {
      expect(m("*", "/base/anything")).toBe(true);
    });

    it("matches a deeply nested file", () => {
      expect(m("*", "/base/a/b/c/deep.txt")).toBe(true);
    });
  });

  describe("`.secret/` — unanchored directory pattern", () => {
    it("matches .secret itself", () => {
      expect(m(".secret/", "/base/.secret")).toBe(true);
    });

    it("matches .secret/x", () => {
      expect(m(".secret/", "/base/.secret/x")).toBe(true);
    });

    it("matches .secret anywhere in the path", () => {
      expect(m(".secret/", "/base/foo/.secret/key.pem")).toBe(true);
    });
  });

  describe("`./` — anchored, everything at/below config dir", () => {
    it("matches the config dir itself", () => {
      expect(m("./", CONFIG_DIR)).toBe(true);
    });

    it("matches a file directly under config dir", () => {
      expect(m("./", `${CONFIG_DIR}/README.md`)).toBe(true);
    });

    it("matches a deeply nested file", () => {
      expect(m("./", `${CONFIG_DIR}/src/lib/foo.ts`)).toBe(true);
    });

    it("does not match a sibling directory", () => {
      expect(m("./", "/home/user/other")).toBe(false);
    });

    it("does not match an unrelated path", () => {
      expect(m("./", "/tmp/something")).toBe(false);
    });
  });

  describe("`./.secret/` — anchored directory pattern", () => {
    it("matches .secret directly under config dir", () => {
      expect(m("./.secret/", `${CONFIG_DIR}/.secret`)).toBe(true);
    });

    it("matches .secret/x under config dir", () => {
      expect(m("./.secret/", `${CONFIG_DIR}/.secret/x`)).toBe(true);
    });

    it("does not match .secret nested further (foo/.secret/x)", () => {
      expect(m("./.secret/", `${CONFIG_DIR}/foo/.secret/x`)).toBe(false);
    });

    it("does not match an unrelated path outside config dir", () => {
      expect(m("./.secret/", "/home/user/other/.secret/x")).toBe(false);
    });
  });

  describe("`./src/*.ts` — anchored multi-segment pattern", () => {
    it("matches src/index.ts relative to config dir", () => {
      expect(m("./src/*.ts", `${CONFIG_DIR}/src/index.ts`)).toBe(true);
    });

    it("matches src/foo.ts relative to config dir", () => {
      expect(m("./src/*.ts", `${CONFIG_DIR}/src/foo.ts`)).toBe(true);
    });

    it("does not match src/lib/foo.ts (too many segments)", () => {
      expect(m("./src/*.ts", `${CONFIG_DIR}/src/lib/foo.ts`)).toBe(false);
    });

    it("does not match src/foo.js (wrong extension)", () => {
      expect(m("./src/*.ts", `${CONFIG_DIR}/src/foo.js`)).toBe(false);
    });

    it("does not match src itself (too few segments)", () => {
      expect(m("./src/*.ts", `${CONFIG_DIR}/src`)).toBe(false);
    });
  });
});

describe("matches — additional edge cases", () => {
  it("unanchored pattern does not match across directories (literal)", () => {
    // '.env' matches any SEGMENT named '.env', not a path component like 'src/.env.local'
    expect(m(".env", "/base/.env.local")).toBe(false);
  });

  it("anchored pattern: config dir itself matches './'", () => {
    expect(m("./", CONFIG_DIR)).toBe(true);
  });

  it("anchored directory: path exactly at pattern boundary matches", () => {
    // ./.secret/ should match configDir/.secret (the directory node itself)
    expect(m("./.secret/", `${CONFIG_DIR}/.secret`)).toBe(true);
  });

  it("anchored non-directory: does not match paths with more segments", () => {
    expect(m("./src", `${CONFIG_DIR}/src/extra`)).toBe(false);
  });

  it("anchored non-directory: does not match paths with fewer segments", () => {
    expect(m("./src/index.ts", `${CONFIG_DIR}/src`)).toBe(false);
  });

  it("unanchored pattern with directory flag matches same as without for segment presence", () => {
    // .git/ (directory flag) still matches any segment named '.git' anywhere
    expect(m(".git/", "/project/.git")).toBe(true);
    expect(m(".git/", "/project/.git/config")).toBe(true);
    expect(m(".git/", "/project/.git/refs/heads/main")).toBe(true);
  });
});
