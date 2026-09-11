import { describe, expect, it } from "vitest";
import { matches } from "../src/matcher.js";
import { parsePattern } from "../src/pattern.js";

const CONFIG_DIR = "/home/user/project";

/** Helper: parse and match in one call */
function m(pattern: string, absolutePath: string, homeDir = "/home/user"): boolean {
  return matches(parsePattern(pattern), absolutePath, homeDir);
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
});

describe("matches — unanchored multi-segment patterns", () => {
  describe("`.pi/PLAN.md` — unanchored multi-segment, non-directory", () => {
    it("matches the terminal path exactly", () => {
      expect(m(".pi/PLAN.md", "/a/.pi/PLAN.md")).toBe(true);
    });

    it("does not match with an extra trailing segment (child)", () => {
      expect(m(".pi/PLAN.md", "/a/.pi/PLAN.md/child")).toBe(false);
    });

    it("does not match a suffixed filename (PLAN.md.bak)", () => {
      expect(m(".pi/PLAN.md", "/a/.pi/PLAN.md.bak")).toBe(false);
    });

    it("does not match when segments are separated by another directory", () => {
      expect(m(".pi/PLAN.md", "/a/.pi/foo/PLAN.md")).toBe(false);
    });

    it("matches case-insensitively", () => {
      expect(m(".pi/PLAN.md", "/a/.PI/plan.MD")).toBe(true);
    });
  });

  describe("`.pi/agent/` — unanchored multi-segment directory (matches anywhere + descendants)", () => {
    it("matches the directory node itself", () => {
      expect(m(".pi/agent/", "/a/.pi/agent")).toBe(true);
    });

    it("matches a descendant of the directory node", () => {
      expect(m(".pi/agent/", "/a/.pi/agent/skills/design.md")).toBe(true);
    });

    it("matches the sequence occurring mid-path (not just at the end)", () => {
      expect(m(".pi/agent/", "/a/.pi/agent/x/.pi/agent")).toBe(true);
    });

    it("does not match when segments are not contiguous", () => {
      expect(m(".pi/agent/", "/a/.pi/foo/agent")).toBe(false);
    });

    it("does not match when only part of the sequence is present", () => {
      expect(m(".pi/agent/", "/a/.pi/other")).toBe(false);
    });
  });
});

describe("matches — additional edge cases", () => {
  it("unanchored pattern does not match across directories (literal)", () => {
    // '.env' matches any SEGMENT named '.env', not a path component like 'src/.env.local'
    expect(m(".env", "/base/.env.local")).toBe(false);
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

  describe("`~/.ssh/` home-anchored pattern matches uppercase directory", () => {
    it("matches HOME_DIR/.SSH/id_rsa", () => {
      expect(m("~/.ssh/", "/home/user/.SSH/id_rsa", "/home/user")).toBe(true);
    });
  });

  describe("`/tmp/repos/` absolute-anchored pattern matches uppercase/mixed-case", () => {
    it("matches /TMP/repos/file.ts", () => {
      expect(m("/tmp/repos/", "/TMP/repos/file.ts")).toBe(true);
    });

    it("matches /tmp/REPOS/file.ts", () => {
      expect(m("/tmp/repos/", "/tmp/REPOS/file.ts")).toBe(true);
    });
  });
});

const HOME_DIR = "/home/user";

describe("matches — absolute-anchored patterns", () => {
  describe("`/tmp/pi-github-repos/` — absolute directory pattern", () => {
    it("matches /tmp/pi-github-repos itself", () => {
      expect(m("/tmp/pi-github-repos/", "/tmp/pi-github-repos")).toBe(true);
    });

    it("matches a file inside /tmp/pi-github-repos", () => {
      expect(m("/tmp/pi-github-repos/", "/tmp/pi-github-repos/repo/README.md")).toBe(true);
    });

    it("does not match /tmp/other", () => {
      expect(m("/tmp/pi-github-repos/", "/tmp/other")).toBe(false);
    });

    it("does not match a path outside /tmp", () => {
      expect(m("/tmp/pi-github-repos/", "/home/user/pi-github-repos")).toBe(false);
    });
  });

  describe("`/tmp/*.log` — absolute wildcard pattern", () => {
    it("matches /tmp/app.log", () => {
      expect(m("/tmp/*.log", "/tmp/app.log")).toBe(true);
    });

    it("matches /tmp/debug.log", () => {
      expect(m("/tmp/*.log", "/tmp/debug.log")).toBe(true);
    });

    it("does not match /tmp/subdir/app.log (too many segments)", () => {
      expect(m("/tmp/*.log", "/tmp/subdir/app.log")).toBe(false);
    });

    it("does not match /tmp/app.txt", () => {
      expect(m("/tmp/*.log", "/tmp/app.txt")).toBe(false);
    });
  });

  describe("`/tmp/foo` — exact absolute path (non-directory)", () => {
    it("matches /tmp/foo exactly", () => {
      expect(m("/tmp/foo", "/tmp/foo")).toBe(true);
    });

    it("does not match /tmp/foo/bar (too many segments)", () => {
      expect(m("/tmp/foo", "/tmp/foo/bar")).toBe(false);
    });

    it("does not match /tmp/bar", () => {
      expect(m("/tmp/foo", "/tmp/bar")).toBe(false);
    });
  });

  describe("absolute-anchored ignores configDir/homeDir", () => {
    it("matches regardless of homeDir", () => {
      expect(m("/tmp/foo/", "/tmp/foo/bar", "/some/other/dir")).toBe(true);
    });
  });
});

describe("matches — home-anchored patterns", () => {
  describe("`~/` — everything at/below home dir", () => {
    it("matches the home dir itself", () => {
      expect(m("~/", HOME_DIR, HOME_DIR)).toBe(true);
    });

    it("matches a file directly under home dir", () => {
      expect(m("~/", `${HOME_DIR}/README.md`, HOME_DIR)).toBe(true);
    });

    it("matches a deeply nested file under home", () => {
      expect(m("~/", `${HOME_DIR}/projects/foo/src/index.ts`, HOME_DIR)).toBe(true);
    });

    it("does not match a path outside home", () => {
      expect(m("~/", "/tmp/something", HOME_DIR)).toBe(false);
    });
  });

  describe("`~/.ssh/` — home-anchored directory", () => {
    it("matches .ssh directly under home", () => {
      expect(m("~/.ssh/", `${HOME_DIR}/.ssh`, HOME_DIR)).toBe(true);
    });

    it("matches .ssh/id_rsa under home", () => {
      expect(m("~/.ssh/", `${HOME_DIR}/.ssh/id_rsa`, HOME_DIR)).toBe(true);
    });

    it("does not match .ssh nested further (projects/.ssh/key)", () => {
      expect(m("~/.ssh/", `${HOME_DIR}/projects/.ssh/key`, HOME_DIR)).toBe(false);
    });

    it("does not match an unrelated path outside home", () => {
      expect(m("~/.ssh/", "/tmp/.ssh/id_rsa", HOME_DIR)).toBe(false);
    });
  });

  describe("`~/.pi/agent/skills/` — deeply nested home-anchored directory", () => {
    it("matches /home/user/.pi/agent/skills/design/SKILL.md", () => {
      expect(m("~/.pi/agent/skills/", `${HOME_DIR}/.pi/agent/skills/design/SKILL.md`, HOME_DIR)).toBe(true);
    });

    it("does not match path at wrong nesting level", () => {
      expect(m("~/.pi/agent/skills/", `${HOME_DIR}/.pi/agent/SKILL.md`, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/file.txt` — exact home-anchored file", () => {
    it("matches exactly /home/user/file.txt", () => {
      expect(m("~/file.txt", `${HOME_DIR}/file.txt`, HOME_DIR)).toBe(true);
    });

    it("does not match /home/user/subdir/file.txt (too many segments)", () => {
      expect(m("~/file.txt", `${HOME_DIR}/subdir/file.txt`, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/*.pem` — home-anchored suffix wildcard", () => {
    it("matches /home/user/cert.pem", () => {
      expect(m("~/*.pem", `${HOME_DIR}/cert.pem`, HOME_DIR)).toBe(true);
    });

    it("does not match /home/user/subdir/cert.pem (too many segments)", () => {
      expect(m("~/*.pem", `${HOME_DIR}/subdir/cert.pem`, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/projects/*.ts` — home-anchored multi-segment", () => {
    it("matches projects/index.ts relative to home", () => {
      expect(m("~/projects/*.ts", `${HOME_DIR}/projects/index.ts`, HOME_DIR)).toBe(true);
    });

    it("does not match projects/lib/foo.ts (too many segments)", () => {
      expect(m("~/projects/*.ts", `${HOME_DIR}/projects/lib/foo.ts`, HOME_DIR)).toBe(false);
    });

    it("does not match projects/foo.js (wrong extension)", () => {
      expect(m("~/projects/*.ts", `${HOME_DIR}/projects/foo.js`, HOME_DIR)).toBe(false);
    });
  });

  describe("`~/.config/` — home-anchored directory matches node and descendants", () => {
    it("matches /home/user/.config (directory node itself)", () => {
      expect(m("~/.config/", `${HOME_DIR}/.config`, HOME_DIR)).toBe(true);
    });

    it("matches /home/user/.config/anything", () => {
      expect(m("~/.config/", `${HOME_DIR}/.config/anything`, HOME_DIR)).toBe(true);
    });
  });

  describe("home-anchored uses homeDir, not any other directory", () => {
    it("matches path under homeDir even when it is outside CONFIG_DIR", () => {
      expect(m("~/", `${HOME_DIR}/other-project/file.ts`, HOME_DIR)).toBe(true);
    });

    it("does not confuse homeDir with an unrelated directory", () => {
      expect(m("~/other", `${CONFIG_DIR}/other`, HOME_DIR)).toBe(false);
      expect(m("~/other", `${HOME_DIR}/other`, HOME_DIR)).toBe(true);
    });
  });

  describe("throws when homeDir is omitted for home-anchored patterns", () => {
    it("throws if homeDir is undefined", () => {
      const pattern = parsePattern("~/.ssh/");
      expect(() => matches(pattern, `${HOME_DIR}/.ssh/id_rsa`)).toThrow(/homeDir is required/);
    });
  });
});
