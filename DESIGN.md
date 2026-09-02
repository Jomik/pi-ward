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

The `read`, `grep`, `ls`, and `find` tools are checked at the tool-call boundary against their path argument. For `grep`/`ls`/`find` this argument is a *root* the tool recurses from, so entry-point checking alone is insufficient — see [Recursive Read Tools](#recursive-read-tools-output-filtering).

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
| `./` | Everything at or below the config's directory | (used to allow access to the full project tree) |
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

Exactly two config files are loaded per session:

1. `~/.pi/agent/ward.json` — **global config**, configDir = home directory.
2. `<projectRoot>/.pi/ward.json` — **project config**, configDir = project root.

Each is optional — ENOENT is silently skipped. Any other read error fails closed. Rules are concatenated in load order (global first, project last) into a single flat list. First match wins — global rules always take precedence.

Regardless of project location, only the global config and the project config are loaded. No ancestor directories are consulted.

**Why global wins:** This inverts the "most-specific-wins" convention familiar from gitconfig or eslint. The inversion is deliberate: a security boundary must not allow untrusted inner configs to weaken trusted outer configs. Global rules are set by the user; project configs may come from cloned repos.
The global config's scope is the home directory — it can allow access anywhere at or below `~`. Additionally, absolute-path patterns (starting with `/`) in the global config can allow access to paths outside `~` (e.g., `/tmp/pi-github-repos/`).

**Trust scoping:** A config can only `allow` access to paths at or below the directory it governs. This is enforced at match time: when a rule matches and its effect is `allow`, the resolved absolute path must be at or below the config's trust scope for the allow to take effect. If not, the rule is skipped and evaluation continues to the next rule.

A config can `deny` any path regardless of scope.

- Global config's trust scope is the home directory — it can `allow` within `~`, and `deny` any path. Absolute-anchored allow rules (prefix `/`) use `/` as their trust scope, meaning they can match any absolute path; they are restricted to the global config only for security.
- Project config's trust scope is the project root — it can `allow` access within the project tree.
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

### Project-Root Conditions (Global Config Only)

Global rules may include an optional top-level `projectRoot` field (string or array of strings) to scope the rule to a specific project. A rule with `projectRoot` is skipped unless the active session's project root exactly matches the given path (or any path in the array). **Project configs may not use `projectRoot`** — this is a load-time error.

Use cases:

- **Sibling project access** — grant read/write access to a related repo only when the agent is working in a specific project:
  ```json
  {
    "rules": [
      {
        "pattern": "~/projects/shared-lib/",
        "effect": "allow",
        "operations": "read",
        "projectRoot": "~/projects/backend"
      }
    ]
  }
  ```
  This allows the backend project to read `~/projects/shared-lib/` while any other project cannot.

- **Multiple projects** — apply the same rule to a set of projects using an array:
  ```json
  {
    "rules": [
      {
        "pattern": "~/projects/shared-lib/",
        "effect": "allow",
        "operations": "read",
        "projectRoot": ["~/projects/backend", "~/projects/api"]
      }
    ]
  }
  ```

**Path resolution:** `projectRoot` values are resolved at config load time. Both absolute paths and `~/`-prefixed home-relative paths are supported. Symlinks are resolved via `realpath`. A `projectRoot` value that does not exist on disk is stored as its normalized form — it will never match a real (realpath-resolved) session project root, so the rule condition is unsatisfiable. An unresolvable path (EACCES, ELOOP, etc.) is a load-time error.

**Matching:** exact resolved path equality between the stored `projectRoot` and the session's `projectRoot`. No prefix/descendant matching — the project root must match exactly.

**Rules without `projectRoot`** are unchanged — they apply to all projects as before.

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

Any file matching the pattern `<dir>/.pi/ward.json` — at any location in the filesystem — is always write-protected. The global config (`~/.pi/agent/ward.json`) is also explicitly protected. This broad structural predicate means the agent cannot create a new config file at a location it could later exploit, and cannot weaken its own constraints by modifying any config. (Deletion/renaming of config files can only happen via bash, which is pi-armory's responsibility.)

### Behavior on Block

- The agent receives an actionable message: which path, which operation, and that it was blocked. It can inform the user rather than silently failing.
- No filesystem I/O occurs — the block happens before execution.

This pre-execution block applies to single-target tools (`read`, `write`, `edit`, `delete`, `move`) and to the *root argument* of the recursive read tools. The recursive read tools additionally filter their results after execution — see below.

### Recursive Read Tools (Output Filtering)

The `grep`, `find`, and `ls` tools take a search/listing root and recurse into it. Checking only the root argument is insufficient: a `grep` from an allowed root (e.g., the project root) recurses into a denied file (e.g., `.env`) and returns its matching line **contents** — exfiltrating data that a direct `read` of the same file would block. `find`/`ls` similarly leak entry names/paths under a denied subtree.

Entry-point checking still applies (a denied root is blocked pre-execution), but for these tools ward adds a second layer: **post-execution output filtering**. After the tool runs, ward inspects its result and removes entries attributable to denied paths before the model sees them.

- **grep** (implemented): each output line (`path:N: text` for matches, `path-N- text` for context) is attributed to its source file and dropped if that file is denied, reusing the same `checkPath` evaluation as pre-execution blocks. grep's structured result carries no per-file data, so the line text is parsed. To resist misattribution (filenames or matched content containing `:N: ` / `-N- `), every candidate split point is enumerated, each candidate is `stat`-verified against the filesystem, and **deny-wins**: a line survives only if every real-file candidate it could refer to is allowed. Unattributable lines are dropped fail-closed. A summary note reports how many matches in how many files were hidden. Single-file `grep` targets resolve via the file's parent directory (grep emits a bare basename); a filter error suppresses all output.
- **find / ls** (planned): same mechanism — attribute each result entry to a path and drop denied ones. Metadata-only (names/paths), lower severity than grep's content leak.

This is necessarily post-hoc: the tool executes, then ward redacts its result. It is a redaction layer, not a pre-execution block — the read happens, but denied content never reaches the model or the session transcript.

### Failure Modes

- **Invalid JSON / schema error in any config:** fail-closed. Session refuses to start with a clear error.
- **Config file unreadable (permissions):** fail-closed.
- **Extension crash during rule evaluation:** fail-closed. The tool call is denied.
- **Invalid pattern syntax:** fail-closed at load time.
- **Allow rule structurally out of scope:** load-time error (consistent with fail-closed).

### Threat Model Scope

Ward checks policy before the tool executes. It does not control the tool's internal I/O implementation. Concurrent filesystem mutation by processes outside the agent (TOCTOU via symlink swaps between check and tool execution) is outside the threat model — ward protects against the agent's own actions, not against a hostile local environment racing the filesystem.

The recursive-read output filter (see above) is inherently post-hoc: it `stat`-checks candidate paths *after* the tool produced its result. Its guarantee — a denied file's matched line is never surfaced — holds only when filesystem state is stable between tool execution and filtering. A same-prefix allowed file appearing (or a denied file disappearing) in that window could cause misattribution. This post-hoc race is an accepted limitation of redacting tool output, consistent with the TOCTOU scope above.

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
3. Rule evaluation (first-match-wins): an allow rule match short-circuits to allow; a deny rule match hard-blocks, no prompt.
4. If baseline would deny (path outside project root):
   a. Check session grants → if match, allow silently.
   b. Check session denies → if match, deny silently.
   c. For reads only, check prompt-derived approval (see [Prompt-Derived Approval](#prompt-derived-approval-implicit-turn-scoped-grants) below) → if match, allow silently, scoped to the current turn.
   d. Prompt user → apply their choice.
5. If baseline would allow (inside project root) → allow.

**Key constraints:**

- Grants are in-memory only — they do not persist across sessions.
- Grants cannot override explicit deny rules — only baseline denies are grantable.
- Directory grants (`directory: true`) cover the path and everything under it.
- Operation semantics mirror rules: a write grant covers read+write; a read deny blocks both.
- When no UI is available (non-interactive mode), baseline denies remain blocked, except where prompt-derived read approval applies (see [Prompt-Derived Approval](#prompt-derived-approval-implicit-turn-scoped-grants) below) — that check needs no UI, only a real user turn.

### Prompt-Derived Approval (Implicit Turn-Scoped Grants)

Interactive approval and `/ward` both require the user to act out-of-band from their request. But often the user's own message already names the path they want read (e.g. "check @/tmp/notes/todo.md") — asking them to also click through a prompt is redundant. Prompt-derived approval treats a concrete matching path reference in the user's own message as consent for that reference, scoped to the turn in which it was made.

**Trigger:** only reached for a read that is otherwise grantable — i.e. baseline-denied (outside project root) with no explicit deny rule and no resolution failure. It sits between session grants/denies and the interactive prompt in the evaluation order. (Self-protection is irrelevant here: it only ever write-protects config files, and this check never covers writes.)

**Remembered input, not a turn model:** the extension keeps a single in-memory value — the text of the latest genuine user input seen this runtime. "Genuine" means the input arrived via an interactive or RPC source; extension-originated input (e.g. injected by a command or tool) is never genuine — it neither becomes the remembered value nor clears it. Every subsequent genuine input replaces the previous one, so the check always compares against the single most recent genuine message, whatever tool calls have happened since. There is no separate notion of conversation branch or turn boundary tracked beyond this: "current turn" below just means "since the last genuine input was recorded and until the next one arrives".

**Source of truth:** the latest genuine (interactive/RPC) input text remembered by the extension, as described above.

**Reference grammar:**

A reference must be adjacent to its own delimiters — no matching across surrounding prose. Four forms are recognized:

| Form | Example | Notes |
|------|---------|-------|
| `@path` | `@/tmp/notes/todo.md` | `@` immediately precedes the path token, no space |
| `@"path with spaces"` | `@"/tmp/my notes/todo.md"` | opening quote immediately follows `@`; required when the path contains whitespace, but also permitted for a whitespace-free path |
| `path` | `/tmp/notes/todo.md` | bare, unquoted — a single whitespace-delimited token |
| `"path with spaces"` | `"/tmp/my notes/todo.md"` | bare, double-quoted; required when the path contains whitespace, but also permitted for a whitespace-free path — quoting a single-token path is parsed as that quoted form once, not additionally as an unquoted candidate |

Rules:
- `@` must be immediately adjacent to the path or its opening quote — `@ /tmp/x` (space after `@`) is not a reference.
- Surrounding whitespace is never part of the path. Wrapping prose punctuation immediately adjacent to an unquoted candidate (a sentence-ending period, a trailing comma or colon, an enclosing parenthesis) is not part of the path either — it is stripped before resolution, never matched against.
- A path that itself contains a character that reads as boundary punctuation (an embedded space, a literal comma, a trailing period, a closing paren) does not reliably survive unquoted extraction and must be written quoted (`@"..."` or `"..."`) to be recognized.
- Extraction operates on the latest genuine user message only, per the definition above. Every substring matching one of the four forms is extracted as a candidate, independently of the others. Each candidate is resolved/canonicalized on its own (symlinks resolved, made absolute, as elsewhere in this design), and independently compared to the tool's own independently canonicalized target path. **Only this final canonical-path equality is spelling-independent** — everything above (delimiter adjacency, quoting, punctuation stripping) operates on the literal message text, not on any canonicalized form.

**What is approved:**

| Target on disk | Marked with `@` | Bare (no `@`) |
|---|---|---|
| Existing regular file | Approved | Approved |
| Existing directory | Approved | Not approved |
| Missing / unknown | Not approved | Not approved |

A bare reference to an existing file is accepted because it authorizes only that exact file — there is no breadth to abuse. A bare reference to a directory is treated as ambiguous prose (e.g. mentioning a directory name in passing) and does not grant access; the `@` marker is required to treat a directory as an intended read target, because a directory approval can extend to recursive tools operating over everything beneath it (see below), which is not a risk a bare mention should silently carry. A missing or otherwise unresolvable target is never approved, regardless of marker — resolution must succeed against a real, existing file or directory. Writes are never eligible for prompt-derived approval — only read operations reach this check.

Because matching compares each candidate's own canonical path against the tool's canonical target, prefix relationships never confuse it: a message containing only `/tmp/ab` never approves a tool call targeting `/tmp/a` — the candidate `/tmp/ab` and the target `/tmp/a` canonicalize to distinct paths, and no other candidate in the message resolves to `/tmp/a`.

**Directory approval and recursive tools (call-scoped, not a grant):** when a directory reference is approved, that approval is captured as ephemeral context tied to the single tool call being evaluated — it is never written to the `GrantStore` and is not a standing grant. For a recursive tool (`grep`/`find`/`ls`) whose root is that approved directory, the same call's output filtering (see [Recursive Read Tools](#recursive-read-tools-output-filtering)) may treat a result entry attributable to a path under the approved root as covered by this context, without re-deriving approval from the message for each entry — but explicit deny rules are still applied to every entry regardless. Once that tool call's result has been filtered and returned, the context is discarded. It confers nothing on any other, later tool call: a separate call targeting a descendant path must independently satisfy the reference grammar against the user's message (its own path text present, or its own root independently approved). `find`/`ls` output filtering, once implemented, uses this same call-scoped context.

**Precedence and non-grantable outcomes:** this check only ever *adds* an allow at the point baseline would otherwise deny. It cannot override an explicit deny rule or a resolution failure — those remain non-grantable and are decided earlier in the evaluation order, before this check is ever reached.

**Scope and lifetime:** approval derived this way is never written to the session `GrantStore` — it is not a grant that persists or shows up in `/ward list`. It is valid only while the message it was derived from remains the remembered latest genuine input. Repeated reads that match the same path are all allowed, each independently re-checked against the same source message rather than cached as a standing grant. As soon as the next genuine input is recorded, the approval lapses; a fresh check against the new remembered message is required for any further access to the same path.

### `/ward` Command (Proactive Session Grants)

The interactive approval flow prompts per-file. The `/ward` slash command lets the user proactively grant or deny access for the current session — pre-populating the same in-memory grants that interactive approval creates.

**Commands:**

```
/ward allow read ~/projects/work/     # grant read to directory + contents
/ward allow write ~/projects/work/    # grant read+write
/ward deny ~/projects/work/           # preemptive session deny
/ward list                            # show active session grants/denies
/ward revoke ~/projects/work/         # remove a grant (reverts to baseline)
/ward status ~/some/path              # show what rules/grants apply to a path
```

**Semantics:**

- Same constraints as interactive grants: cannot override explicit deny rules. Only baseline denies are grantable.
- Directory patterns: trailing `/` covers the path and everything underneath.
- Operation semantics: `write` implies read+write. `read` is read-only. Omitting the operation defaults to `read`.
- Scope is always session — no persistence.
- Path resolution: `~/` expanded at grant time. Symlinks resolved. Relative paths resolved from project root.
- Literal paths and directory patterns only — no globs, no wildcards.

**Evaluation order (unchanged):**

Fits into the existing step 4 — session grants checked before prompting:

1. Path resolution
2. Self-protection check
3. Rule evaluation (first-match-wins): an allow rule match short-circuits to allow; a deny rule match hard-blocks, no override
4. Baseline deny?
   - a. Check session grants → `/ward` grants live here
   - b. Check session denies → `/ward deny` lives here
   - c. For reads only, check prompt-derived approval (see [Prompt-Derived Approval](#prompt-derived-approval-implicit-turn-scoped-grants)) → turn-scoped, not stored
   - d. Prompt user (if no grant/deny/approval matches)
5. Baseline allow → allow

**`/ward list` output:**

```
Session grants:
  allow read   ~/projects/work/          (directory)
  deny  read   ~/secrets/                 (directory)
  allow read   ~/notes/reference.md      (file)
```

**`/ward revoke`:**

Removes the grant/deny from session state. Future access falls back to baseline → interactive prompt.

**`/ward status <path>`:**

Reports the evaluation result for a path: which rule or grant applies, what the outcome would be, and why. Useful for debugging "why was this blocked?"

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
9. Recursive read tools (`grep`; `find`/`ls` planned) execute, but result lines/entries attributable to a denied path are redacted from the output before the model sees them, fail-closed (unattributable output is dropped).
