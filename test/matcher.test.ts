import { describe, expect, it } from "vitest";
import { matches } from "../src/matcher.js";
import { parsePattern } from "../src/pattern.js";

const CONFIG_DIR = "/home/user/project";

/** Helper: parse and match in one call */
function m(pattern: string, absolutePath: string, configDir = CONFIG_DIR, homeDir = "/home/user"): boolean {
  return matches(parsePattern(pattern), configDir, absolutePath, homeDir);
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

describe("matches — case-insensitive matching", () => {
  describe("`.env` literal matches uppercase/mixed-case", () => {
    it("matches .ENV", () => {
      expect(m(".env", "/base/.ENV")).toBe(true);
    });

    it("matches .Env", () => {
      expect(m(".env", "/base/.Env")).toBe(true);
    });
  });

  describe("`*.pem` suffix wildcard matches uppercase/mixed-case", () => {
    it("matches CERT.PEM", () => {
      expect(m("*.pem", "/base/CERT.PEM")).toBe(true);
    });

    it("matches cert.PEM", () => {
      expect(m("*.pem", "/base/cert.PEM")).toBe(true);
    });
  });

  describe("`.env*` prefix wildcard matches uppercase/mixed-case", () => {
    it("matches .ENV.local", () => {
      expect(m(".env*", "/base/.ENV.local")).toBe(true);
    });

    it("matches .Env.Production", () => {
      expect(m(".env*", "/base/.Env.Production")).toBe(true);
    });
  });

  describe("`./src/*.ts` anchored pattern matches uppercase extension", () => {
    it("matches CONFIG_DIR/src/index.TS", () => {
      expect(m("./src/*.ts", `${CONFIG_DIR}/src/index.TS`)).toBe(true);
    });
  });

  describe("`~/.ssh/` home-anchored pattern matches uppercase directory", () => {
    it("matches HOME_DIR/.SSH/id_rsa", () => {
      expect(m("~/.ssh/", "/home/user/.SSH/id_rsa", CONFIG_DIR, "/home/user")).toBe(true);
    });
  });
});

const HOME_DIR = "/home/user";

describe("matches — home-anchored patterns", () => {
  describe("`~/` — everything at/below home dir", () => {
    it("matches the home dir itself", () => {
      expect(m("~/", HOME_DIR, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("matches a file directly under home dir", () => {
      expect(m("~/", `${HOME_DIR}/README.md`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("matches a deeply nested file under home", () => {
      expect(m("~/", `${HOME_DIR}/projects/foo/src/index.ts`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("does not match a path outside home", () => {
      expect(m("~/", "/tmp/something", CONFIG_DIR, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/.ssh/` — home-anchored directory", () => {
    it("matches .ssh directly under home", () => {
      expect(m("~/.ssh/", `${HOME_DIR}/.ssh`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("matches .ssh/id_rsa under home", () => {
      expect(m("~/.ssh/", `${HOME_DIR}/.ssh/id_rsa`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("does not match .ssh nested further (projects/.ssh/key)", () => {
      expect(m("~/.ssh/", `${HOME_DIR}/projects/.ssh/key`, CONFIG_DIR, HOME_DIR)).toBe(false);
    });

    it("does not match an unrelated path outside home", () => {
      expect(m("~/.ssh/", "/tmp/.ssh/id_rsa", CONFIG_DIR, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/.pi/agent/skills/` — deeply nested home-anchored directory", () => {
    it("matches /home/user/.pi/agent/skills/design/SKILL.md", () => {
      expect(m("~/.pi/agent/skills/", `${HOME_DIR}/.pi/agent/skills/design/SKILL.md`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("does not match path at wrong nesting level", () => {
      expect(m("~/.pi/agent/skills/", `${HOME_DIR}/.pi/agent/SKILL.md`, CONFIG_DIR, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/file.txt` — exact home-anchored file", () => {
    it("matches exactly /home/user/file.txt", () => {
      expect(m("~/file.txt", `${HOME_DIR}/file.txt`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("does not match /home/user/subdir/file.txt (too many segments)", () => {
      expect(m("~/file.txt", `${HOME_DIR}/subdir/file.txt`, CONFIG_DIR, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/*.pem` — home-anchored suffix wildcard", () => {
    it("matches /home/user/cert.pem", () => {
      expect(m("~/*.pem", `${HOME_DIR}/cert.pem`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("does not match /home/user/subdir/cert.pem (too many segments)", () => {
      expect(m("~/*.pem", `${HOME_DIR}/subdir/cert.pem`, CONFIG_DIR, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/projects/*.ts` — home-anchored multi-segment", () => {
    it("matches projects/index.ts relative to home", () => {
      expect(m("~/projects/*.ts", `${HOME_DIR}/projects/index.ts`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("does not match projects/lib/foo.ts (too many segments)", () => {
      expect(m("~/projects/*.ts", `${HOME_DIR}/projects/lib/foo.ts`, CONFIG_DIR, HOME_DIR)).toBe(false);
    });

    it("does not match projects/foo.js (wrong extension)", () => {
      expect(m("~/projects/*.ts", `${HOME_DIR}/projects/foo.js`, CONFIG_DIR, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/.config/` — home-anchored directory matches node and descendants", () => {
    it("matches /home/user/.config (directory node itself)", () => {
      expect(m("~/.config/", `${HOME_DIR}/.config`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("matches /home/user/.config/anything", () => {
      expect(m("~/.config/", `${HOME_DIR}/.config/anything`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });
  });

  describe("home-anchored uses homeDir, not configDir", () => {
    it("matches path under homeDir even when it is outside configDir", () => {
      // configDir is /home/user/project, homeDir is /home/user
      // ~/ should anchor to homeDir, not configDir
      expect(m("~/", `${HOME_DIR}/other-project/file.ts`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });

    it("does not confuse homeDir and configDir", () => {
      // ~/other does NOT match configDir/other — it must be relative to homeDir
      expect(m("~/other", `${CONFIG_DIR}/other`, CONFIG_DIR, HOME_DIR)).toBe(false);
      expect(m("~/other", `${HOME_DIR}/other`, CONFIG_DIR, HOME_DIR)).toBe(true);
    });
  });

  describe("throws when homeDir is omitted for home-anchored patterns", () => {
    it("throws if homeDir is undefined", () => {
      const pattern = parsePattern("~/.ssh/");
      expect(() => matches(pattern, CONFIG_DIR, `${HOME_DIR}/.ssh/id_rsa`)).toThrow(/homeDir is required/);
    });
  });
});
