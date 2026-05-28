# pi-ward

File access guard for the pi coding agent. Complements pi-armory (which controls command execution) by controlling what the agent can read and write on the filesystem.

## Problem

The agent's file tools have unrestricted filesystem access. It can read secrets, write outside the project tree, or corrupt version control internals. No mechanism exists to enforce boundaries without manual vigilance.

## Approach

A pi extension that intercepts file operations and enforces declarative access rules. Rules use simple path patterns and evaluate top-to-bottom with first-match-wins semantics.

### Definitions

- **Project root**: the working directory of the pi session (pi always launches in the project root).
- **Path segment**: a single `/`-delimited component of a path (e.g., in `src/.env.local`, the segments are `src` and `.env.local`).

### Access Model

The baseline policy:

- **Read within project root:** allowed
- **Write within project root:** allowed
- **Any access outside project root:** denied

User-declared rules override the baseline. Without any config, the agent works normally within the project but cannot escape it.

### Operations

Two logical operations, covering all file-touching tools:

| Operation | Covers |
|-----------|--------|
| `read` | read, grep, ls, find |
| `write` | write, edit, delete |

### Rule Structure

A rule specifies a pattern, which operations it governs, and what effect to apply:

- **pattern** — simple path pattern. See Pattern Matching below.
- **operations** — `"read"` or `"write"`. Defaults to `"read"` (restrictive). See semantics below.

**Effect × operation semantics** ("write implies read"):

| effect | operations | Result |
|--------|------------|--------|
| `allow` | `"read"` (default) | Grants read access only |
| `allow` | `"write"` | Grants full access (read + write) |
| `deny` | `"read"` (default) | Denies all access (can't read → can't write) |
| `deny` | `"write"` | Denies writes only (path becomes read-only) |

Project baseline (inside projectRoot, no matching rule): full write access.

- **effect** — `allow` or `deny`.

Rules are evaluated top-to-bottom. The first matching rule determines the outcome. If no rule matches, the baseline policy applies.

### Pattern Matching

Minimal pattern syntax:

| Syntax | Meaning | Example |
|--------|---------|--------|
| `.env` | Matches any segment exactly equal to `.env` | `.env` ✓, `src/.env` ✓, `.env/secrets` ✓ |
| `.env*` | Matches any segment starting with `.env` | `.env.local` ✓, `foo/.env.production` ✓ |
| `*.pem` | Matches any segment ending with `.pem` | `cert.pem` ✓, `foo/bar/key.pem` ✓ |
| `*` | Matches any single segment | any file or directory name ✓ |
| `.secret/` | Trailing `/` — matches the directory and anything under it at any depth | `.secret` ✓, `.secret/x` ✓, `foo/.secret/key.pem` ✓ |
| `./` | Everything at or below the config's directory | (used in group-level configs to allow sibling access) |
| `./.secret/` | `./` anchors to the config's directory | `.secret/x` ✓, `foo/.secret/x` ✗ |
| `./src/*.ts` | `*` works within any segment in an anchored path | `src/index.ts` ✓, `src/lib/foo.ts` ✗ |
| `~/.ssh/` | `~/` anchors to the home directory (absolute) | `~/.ssh/id_rsa` ✓, `/tmp/.ssh/key` ✗ |
| `~/.pi/agent/skills/` | Home-anchored directory match | `~/.pi/agent/skills/design/SKILL.md` ✓ |
| `/tmp/repos/` | Absolute path — matches the directory and everything under it (global config only) | `/tmp/repos/foo` ✓, `/var/repos/foo` ✗ |
| `/tmp/*.log` | Absolute path with wildcard | `/tmp/app.log` ✓, `/tmp/sub/app.log` ✗ |

Rules:
- **No prefix** — unanchored. Must be a single-segment pattern. Matches against every segment in the path.
- **`./`** — anchored to the directory the config governs (parent of the `.pi/` directory containing the config). Can include path separators. **Not valid in the global config** (there is no governing directory).
- **`~/`** — anchored to the home directory. The home path is captured at config load time and used for matching. Can include path separators. Useful in the global config for targeting specific paths.
- **`/`** — absolute path anchor. Can include path separators. **Only valid in the global config.** The leading literal segments are resolved via `realpath` at config load time to canonicalize symlinks (e.g., `/tmp/repos/` → `/private/tmp/repos/` on macOS). Useful for granting access to paths outside the home directory.
- **Trailing `/`** — directory match: the directory node itself and everything under it.
- **`*`** — wildcard within a single segment (does not cross `/`). Matches one or more characters. Prefix (`foo*`), suffix (`*.ext`), or both (`foo*.ext`).
- Unanchored patterns containing `/` are invalid (syntax error). Use `./` or `~/` to write multi-segment patterns.
- No `**`, no braces, no extglobs, no regex. Complexity is the enemy of a security boundary.
- Invalid pattern syntax is a load-time error.

### Configuration

Rules are loaded by walking the directory tree from global toward the project root. Each `.pi/ward.json` found along the path contributes rules.

**Walk algorithm:**

1. Load `~/.pi/agent/ward.json` (global config, fixed location).
2. Starting from the home directory, walk toward the project root. At each ancestor directory, check for `.pi/ward.json` and load it if present.
3. Load the project root's own `.pi/ward.json` last.

The walk does not extend above the home directory. Sessions with a project root outside `~` use only the global config.

Rules are concatenated in load order (global first, project last) into a single flat list. First match wins — global rules always take precedence.

**Why global wins:** This inverts the "most-specific-wins" convention familiar from gitconfig or eslint. The inversion is deliberate: a security boundary must not allow untrusted inner configs to weaken trusted outer configs. Global rules are set by the user; project configs may come from cloned repos.
The global config's scope is the home directory — it can allow access anywhere at or below `~`. Additionally, absolute-path patterns (starting with `/`) in the global config can allow access to paths outside `~` (e.g., `/tmp/pi-github-repos/`).

**Trust scoping:** A config can only `allow` access to paths at or below the directory it governs. This is enforced at match time: when a rule matches and its effect is `allow`, the resolved absolute path must be at or below the config's trust scope for the allow to take effect. If not, the rule is skipped and evaluation continues to the next rule.

A config can `deny` any path regardless of scope.

- Global config's trust scope is the home directory — it can `allow` within `~`, and `deny` any path. Absolute-anchored allow rules (prefix `/`) use `/` as their trust scope, meaning they can match any absolute path; they are restricted to the global config only for security.
- `~/projects/private/.pi/ward.json` can allow access within `~/projects/private/`.
- A leaf project config can only allow within its own tree (which the baseline already grants).
- An `allow` rule that can never take effect (pattern structurally references outside the config's scope) is a load-time error.
- `./` patterns are rejected in the global config at load time (use `~/` or unanchored patterns instead).

Example `~/.pi/agent/ward.json` (global config):
```json
{
  "rules": [
    { "pattern": "~/.pi/agent/skills/", "effect": "allow" },
    { "pattern": "/tmp/pi-github-repos/", "effect": "allow" },
    { "pattern": ".env*", "effect": "deny" },
    { "pattern": "*.pem", "effect": "deny" },
    { "pattern": "~/.ssh/", "effect": "deny" }
  ]
}
```

This says: allow reading the skills directory from any project, deny `.env*` and `*.pem` everywhere, deny `~/.ssh`.

Example `~/projects/private/.pi/ward.json` (group level):
```json
{
  "rules": [
    { "pattern": "./", "effect": "allow" }
  ]
}
```

This says: any project under `~/projects/private/` can read anything else under `~/projects/private/`.

Example project-level `.pi/ward.json`:
```json
{
  "rules": [
    { "pattern": ".git/", "operations": "write", "effect": "deny" },
    { "pattern": ".secret/", "effect": "deny" }
  ]
}
```

### Path Resolution

Before matching, all paths are resolved:

- Paths are normalized and resolved to absolute form.
- Symlinks are resolved to their real path before matching — no symlink escapes.
- Broken symlinks (dangling, unresolvable) are denied.
- Matching is case-insensitive.

### Self-Protection

Ward config files throughout the ancestor chain are always write-protected. This is a built-in invariant — the agent cannot modify its own access controls. (Deletion/renaming of config files can only happen via bash, which is pi-armory's responsibility.)

### Behavior on Block

- The agent receives an actionable message: which path, which operation, and that it was blocked. It can inform the user rather than silently failing.
- No filesystem I/O occurs — the block happens before execution.

### Failure Modes

- **Invalid JSON / schema error in any config:** fail-closed. Session refuses to start with a clear error.
- **Config file unreadable (permissions):** fail-closed.
- **Extension crash during rule evaluation:** fail-closed. The tool call is denied.
- **Invalid pattern syntax:** fail-closed at load time.
- **Allow rule structurally out of scope:** load-time error (consistent with fail-closed).

### Threat Model Scope

Ward checks policy before the tool executes. It does not control the tool's internal I/O implementation. Concurrent filesystem mutation by processes outside the agent (TOCTOU via symlink swaps between check and tool execution) is outside the threat model — ward protects against the agent's own actions, not against a hostile local environment racing the filesystem.

### Runtime Grants (Interactive Approval)

When a path is denied by baseline policy (outside project root, no explicit deny rule), ward prompts the user for approval via the TUI before blocking. This allows controlled access to external paths without pre-configuring rules.

**Prompt flow (two steps):**

When a baseline deny is triggered with a UI available, ward presents two sequential prompts:

1. **Action** — `"Deny"` / `"Approve"` (deny is first, fail-closed default)
2. **Scope** — `"Once"` / `"For session"`

Combining these:

| Action | Scope | Effect |
|--------|-------|--------|
| Deny | Once | Block this call. Ask again on next attempt. |
| Deny | For session | Block and remember — suppress future prompts for this path. |
| Approve | Once | Allow this single call. No state stored. |
| Approve | For session | Allow and remember — auto-approve future access to this path. |

If the user dismisses either prompt (e.g., Escape), the access is denied once without storing state.

**Evaluation order (checkPath + handler):**

1. Path resolution (symlink resolve, broken symlink check).
2. Self-protection check (ward config files are always write-protected).
3. Rule evaluation (first-match-wins). If a deny rule matches → hard deny, no prompt.
4. If baseline would deny (path outside project root):
   a. Check session grants → if match, allow silently.
   b. Check session denies → if match, deny silently.
   c. Prompt user → apply their choice.
5. If baseline would allow (inside project root) → allow.

**Key constraints:**

- Grants are in-memory only — they do not persist across sessions.
- Grants cannot override explicit deny rules — only baseline denies are grantable.
- Directory grants (`directory: true`) cover the path and everything under it.
- Operation semantics mirror rules: a write grant covers read+write; a read deny blocks both.
- When no UI is available (non-interactive mode), baseline denies remain blocked.

## Non-Goals

- **Bash command filtering** — pi-armory's responsibility.
- **Network access control** — out of scope.
- **Per-model or per-session rules** — single policy per directory tree.
- **Audit logging** — the TUI already shows blocked tool calls.
- **Overriding global rules from project config** — intentional. If a global deny is too broad, adjust the global config.
- **Recursive wildcards** — no `**` support. A directory pattern (`dir/`) covers the recursive case for access control purposes.

## Key Invariants

1. A blocked operation never touches the filesystem.
2. Symlinks cannot bypass rules — real paths are always resolved.
3. Paths outside the project root are denied by default.
4. A config can only allow access at or below its own directory (enforced at match time).
5. Ward config files are always write-protected.
6. Rules are pure data (JSON) — no executable logic in config.
7. Any config error fails closed — never fails open.
8. An empty or missing config results in the baseline policy (project-internal allowed, external denied).
