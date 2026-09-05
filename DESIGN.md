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
| `.pi/PLAN.md` | Unanchored, multi-segment, no trailing `/` — matches the contiguous segment sequence only at the *end* of the path (a terminal file, not a directory) | `/a/.pi/PLAN.md` ✓, `/a/.pi/PLAN.md/child` ✗, `.pi/PLAN.md.bak` ✗, `/a/.pi/foo/PLAN.md` ✗ |
| `.pi/agent/` | Unanchored, multi-segment, trailing `/` — matches the contiguous segment sequence *anywhere* in the path, plus all descendants | `.pi/agent` ✓, `.pi/agent/skills/x` ✓, `x/.pi/agent` ✓ |
| `./` | Everything at or below the config's directory | (used to allow access to the full project tree) |
| `./.secret/` | `./` anchors to the config's directory | `.secret/x` ✓, `foo/.secret/x` ✗ |
| `./src/*.ts` | `*` works within any segment in an anchored path | `src/index.ts` ✓, `src/lib/foo.ts` ✗ |
| `~/.ssh/` | `~/` anchors to the home directory (absolute) | `~/.ssh/id_rsa` ✓, `/tmp/.ssh/key` ✗ |
| `~/.pi/agent/skills/` | Home-anchored directory match | `~/.pi/agent/skills/design/SKILL.md` ✓ |
| `/tmp/repos/` | Absolute path — matches the directory and everything under it (global config only) | `/tmp/repos/foo` ✓, `/var/repos/foo` ✗ |
| `/tmp/*.log` | Absolute path with wildcard | `/tmp/app.log` ✓, `/tmp/sub/app.log` ✗ |

Rules:
- **No prefix** — unanchored. May be a single segment or contain `/` for multiple segments.
  - Single segment: matches against every segment in the path (unchanged from before).
  - Multiple segments (e.g. `.pi/PLAN.md`): each `/`-delimited component is parsed as a segment
    pattern (same wildcard rules as any other segment; interior empty segments are rejected).
    - **No trailing `/` (terminal/file pattern):** the segment sequence must match *only at the
      end* of the path — i.e. it identifies a specific terminal node, not a directory. It does not
      match if there are additional trailing segments (e.g. a child of that node), nor if the
      sequence appears elsewhere followed by other segments.
    - **Trailing `/` (directory pattern):** the segment sequence may match *anywhere* in the path,
      and matches that node plus everything beneath it, exactly like a single-segment directory
      pattern.
  - Example — letting the agent maintain its own planning docs while protecting the rest of `.pi/`:
    ```json
    {
      "rules": [
        { "pattern": ".pi/PLAN.md", "operations": "write", "effect": "allow" },
        { "pattern": ".pi/DESIGN.md", "operations": "write", "effect": "allow" },
        { "pattern": ".pi/", "operations": "write", "effect": "deny" }
      ]
    }
    ```
    This allows writes to `.pi/PLAN.md` and `.pi/DESIGN.md` specifically (first-match-wins), then
    denies writes anywhere else under `.pi/` — including `.pi/PLAN.md/child`, which is not the
    terminal node the first rule names. `.pi/ward.json` remains blocked regardless, by
    self-protection.
- **`./`** — anchored to the directory the config governs (parent of the `.pi/` directory containing the config). Can include path separators. **Not valid in the global config** (there is no governing directory).
- **`~/`** — anchored to the home directory. The home path is captured at config load time and used for matching. Can include path separators. Useful in the global config for targeting specific paths.
- **`/`** — absolute path anchor. Can include path separators. **Only valid in the global config.** The leading literal segments are resolved via `realpath` at config load time to canonicalize symlinks (e.g., `/tmp/repos/` → `/private/tmp/repos/` on macOS). Useful for granting access to paths outside the home directory.
- **Trailing `/`** — directory match: the directory node itself and everything under it.
- **`*`** — wildcard within a single segment (does not cross `/`). Matches one or more characters. Prefix (`foo*`), suffix (`*.ext`), or both (`foo*.ext`).
- Unanchored patterns may contain `/` for multi-segment matching (see table above); interior empty segments (e.g. `.pi//PLAN.md`) are invalid.
- No `**`, no braces, no extglobs, no regex. Complexity is the enemy of a security boundary.
- Invalid pattern syntax is a load-time error.

### Configuration

Exactly two config files are loaded per session:

1. `~/.pi/agent/ward.json` — **global config**, configDir = home directory.
2. `<projectRoot>/.pi/ward.json` — **project config**, configDir = project root.

Each is optional — ENOENT is silently skipped. Any other read error fails closed. Rules are concatenated in load order (global first, project last) into a single flat list. First match wins — global rules always take precedence.

Regardless of project location, only the global config and the project config are loaded. No ancestor directories are consulted.

**Why global wins:** This inverts the "most-specific-wins" convention familiar from gitconfig or eslint. The inversion is deliberate: a security boundary must not allow untrusted inner configs to weaken trusted outer configs. Global rules are set by the user; project configs may come from cloned repos.

**Trust asymmetry between the two configs:** the global config is trusted — it is user-authored and lives outside any repository. The project config (`<projectRoot>/.pi/ward.json`) is untrusted: it may be checked into and cloned with the repository it governs, so its author is whoever controls that repository's contents, not necessarily the user. A project config can express policy for its own tree (e.g. denying writes to its own `.git/`), but it can never expand authority beyond the project root, and it can never override or weaken a global rule — self-protection does not make repository-supplied content trusted. Personal per-project grants (e.g. "let project A read sibling directory B") therefore belong in the global config, scoped with an exact-match `projectRoot` condition (see below), not in the project's own config.
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

**Matching:** exact resolved path equality between the stored `projectRoot` and the session's `projectRoot`. No prefix/descendant matching — the project root must match exactly. Requiring both a canonical, exact match and residence in the trusted global config is what keeps this mechanism from becoming a general-purpose grant store: it is one condition on one already-trusted config, not a new place to store authority.

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

Self-protection must block two distinct things, and neither alone is sufficient:

1. **Nominal structural paths.** Any path matching the pattern `<dir>/.pi/ward.json` — at any location in the filesystem, including a path that does not yet exist — is always write-protected. This stops the agent from *creating* a new config file at a location it could later load and exploit, not just from modifying an existing one.
2. **Canonical identity of the configs actually in effect.** The realpath of the global config and the realpath of the project config, both captured once during config loading for the current session, are also always write-protected — regardless of what path is used to reach them. This is necessary because a write tool's target need not textually look like `.pi/ward.json` to end up mutating one of these files: a symlinked `.pi` or `.pi/agent` ancestor directory, or a direct symlink/hardlink alias pointing at the canonical config file, can present a different nominal path while resolving to the same on-disk file.

Checking only the final realpath's basename is **not** sufficient on its own — a nominal-path check is still required to catch pre-creation (a not-yet-existing file has no realpath to compare), and a realpath check is still required to catch aliasing of an existing config through symlinked ancestors or direct links. Both checks run on every candidate write target. Together they mean the agent cannot create a new config file at an exploitable location, and cannot weaken its own constraints by modifying any config through its nominal path or any alias that resolves to it. (Deletion/renaming of config files can only happen via bash, which is pi-armory's responsibility.)

**Scope relative to `/ward project`:** the self-protection guarantees above apply to normal, agent-mediated file access — the guarded tools (`read`, `write`, `edit`, `delete`, `move`, and the recursive read tools) as invoked by the model during a session. They do not create, and are not weakened by, any other path to mutating the config files. The `/ward project` command's internal writer (see [`/ward project` Command](#ward-project-command-persistent-project-rules)) is the single sanctioned exception: a ward-internal code path, gated on explicit interactive user confirmation before every write, that mutates the trusted global config directly rather than through the guarded tool layer. It does not pass through, enable, or weaken ordinary tool access to the config files in any way — a model-issued `write`/`edit`/`delete` targeting either config's nominal or canonical path remains blocked exactly as described above, confirmation or no confirmation. `/ward project` is the only sanctioned mutation path for ward's own policy; there is no other route, agent-mediated or otherwise, by which the model or a guarded tool can alter either config file.

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
- **`/ward project` write path (see [Safe write procedure](#ward-project-command-persistent-project-rules)):** a busy/stale lock, the on-disk source having changed since it was read, validation failure of the assembled config, or failure of the atomic replace step are all reported to the user as a failed write — none of these is ever presented as a successful persist.
- **`/ward project` post-write reload failure:** the disk write itself may have succeeded validly, but if reloading policy into the running session fails, the prior in-memory policy stays active for the rest of the session; the user is told the change is on disk but not yet enforced, and that a restart or manual repair is needed.

### Threat Model Scope

Ward's guarantees apply to operations mediated through its guarded tools (`read`, `grep`, `ls`, `find`, `write`, `edit`, `delete`, `move`). It checks policy before such a tool executes and does not control the tool's internal I/O implementation. Anything that reaches the filesystem outside that mediation — a bash command, an external process, or any other unguarded code path — is outside ward's boundary entirely, not merely unenforced within it; ward makes no claim about it one way or the other (bash is pi-armory's responsibility, see Non-Goals). Where the host extension framework's handler ordering or the ability of one extension to observe/mutate another's tool call is load-bearing for a guarantee above, that guarantee is only as strong as the host's assumptions on that point, not something ward independently verifies.

Concurrent filesystem mutation by processes outside the agent (TOCTOU via symlink swaps between check and tool execution) is outside the threat model — ward protects against the agent's own actions, not against a hostile local environment racing the filesystem.

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
3. Check session denies → if match, deny silently. This is a hard block: it overrides rule allows, baseline allows, session grants, and call-scoped approvals, and is checked before rule evaluation.
4. Rule evaluation (first-match-wins): an allow rule match short-circuits to allow; a deny rule match hard-blocks, no prompt.
5. If baseline would deny (path outside project root):
   a. Check session grants → if match, allow silently.
   b. For reads only, check prompt-derived approval (see [Prompt-Derived Approval](#prompt-derived-approval-implicit-turn-scoped-grants) below) → if match, allow silently, scoped to the current turn.
   c. Prompt user → apply their choice.
6. If baseline would allow (inside project root) → allow.

**Key constraints:**

- Grants are in-memory only — they do not persist across sessions.
- Grants cannot override explicit deny rules — only baseline denies are grantable.
- Session denies are the exception: they are always stored (even inside project root, even where a rule or grant would otherwise allow), and always checked first — they override rule allows, baseline allows, session grants, and call-scoped approvals.
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
| Existing descendant of an `@`-marked directory | Approved | Not approved |
| Missing / unknown | Not approved | Not approved |

A bare reference to an existing file is accepted because it authorizes only that exact file — there is no breadth to abuse. A bare reference to a directory is treated as ambiguous prose (e.g. mentioning a directory name in passing) and does not grant access; the `@` marker is required to treat a directory as an intended read target, because a directory approval extends to every existing path beneath it for the remainder of the turn, which is not a risk a bare mention should silently carry. An `@`-marked reference to an existing file grants no such breadth — it authorizes only that exact file, never a sibling or descendant. A missing or otherwise unresolvable target is never approved, regardless of marker — resolution must succeed against a real, existing file or directory. Writes are never eligible for prompt-derived approval — only read operations reach this check.

Because matching compares each candidate's own canonical path against the tool's canonical target, prefix relationships never confuse it: a message containing only `/tmp/ab` never approves a tool call targeting `/tmp/a` — the candidate `/tmp/ab` and the target `/tmp/a` canonicalize to distinct paths, and no other candidate in the message resolves to `/tmp/a`.

**Directory approval and its subtree (turn-scoped, not a grant):** an `@`-marked directory reference authorizes reads of the directory itself and any existing canonical descendant beneath it, for as long as the message it was derived from remains the remembered latest genuine input — this is re-checked independently for every tool call, including separate later read calls in the same turn, and is never written to the `GrantStore`. Separately, for a recursive tool (`grep`) whose root is that approved directory, the same call's output filtering (see [Recursive Read Tools](#recursive-read-tools-output-filtering)) treats a result entry attributable to a path under the approved root as covered by call-scoped context, without re-deriving approval from the message for each entry — but explicit deny rules are still applied to every entry regardless. That call-scoped context is discarded once the call's result has been filtered and returned; it is distinct from, and narrower in lifetime than, the subtree read approval above. `find`/`ls` output filtering, once implemented, uses this same call-scoped context.

**Precedence and non-grantable outcomes:** this check only ever *adds* an allow at the point baseline would otherwise deny. It cannot override an explicit deny rule or a resolution failure — those remain non-grantable and are decided earlier in the evaluation order, before this check is ever reached.

**Scope and lifetime:** approval derived this way is never written to the session `GrantStore` — it is not a grant that persists or shows up in `/ward list`. It is valid only while the message it was derived from remains the remembered latest genuine input. Repeated reads that match the same path are all allowed, each independently re-checked against the same source message rather than cached as a standing grant. As soon as the next genuine input is recorded, the approval lapses; a fresh check against the new remembered message is required for any further access to the same path.

### `/ward` Command (Proactive Session Grants)

The interactive approval flow prompts per-file. The `/ward` slash command lets the user proactively grant or deny access for the current session — pre-populating the same in-memory grants that interactive approval creates.

**Commands:**

```
/ward allow read ~/projects/work/     # grant read to directory + contents
/ward allow write ~/projects/work/    # grant read+write
/ward deny ~/projects/work/           # preemptive session deny (default read: blocks read+write)
/ward deny write ~/projects/work/     # preemptive session deny, write only (read still permitted)
/ward list                            # show active session grants/denies
/ward revoke ~/projects/work/         # remove a grant (reverts to baseline)
/ward status ~/some/path              # show what rules/grants apply to a path
```

**Semantics:**

- Allows: cannot override explicit deny rules. Only baseline denies are grantable.
- Denies: always stored, regardless of what a rule or baseline would otherwise decide — including paths inside the project root and paths an explicit rule would allow. A session deny is a hard temporary block for the remainder of the process: it overrides rule allows, baseline allows, session grants, and call-scoped approvals.
- Directory patterns: trailing `/` covers the path and everything underneath.
- Operation semantics: `write` implies read+write for allow; for deny, `read` (default) blocks read+write, `write` blocks writes only. Omitting the operation defaults to `read`.
- Scope is always session — no persistence.
- Path resolution: `~/` expanded at grant time. Symlinks resolved. Relative paths resolved from project root.
- Literal paths and directory patterns only — no globs, no wildcards.

**Evaluation order:**

`/ward` grants and denies plug into the same evaluation order described in [Runtime Grants](#runtime-grants-interactive-approval) above — session denies are checked immediately after self-protection, before rule evaluation:

1. Path resolution
2. Self-protection check
3. Check session denies → `/ward deny` lives here; hard block, checked first
4. Rule evaluation (first-match-wins): an allow rule match short-circuits to allow; a deny rule match hard-blocks, no override
5. Baseline deny?
   - a. Check session grants → `/ward` grants live here
   - b. For reads only, check prompt-derived approval (see [Prompt-Derived Approval](#prompt-derived-approval-implicit-turn-scoped-grants)) → turn-scoped, not stored
   - c. Prompt user (if no grant/deny/approval matches)
6. Baseline allow → allow

**`/ward list` output:**

```
Session decisions:
  allow read   ~/projects/work/          (directory)
  deny  read   ~/secrets/                 (directory)
  allow read   ~/notes/reference.md      (file)
```

**`/ward revoke`:**

Removes the grant/deny from session state. Future access falls back to baseline → interactive prompt.

**`/ward status <path>`:**

Reports the evaluation result for a path: which rule or grant applies, what the outcome would be, and why — reflecting the same hard session-deny precedence as the evaluation order above (a session deny always wins, even over an allow rule or grant). Useful for debugging "why was this blocked?"

### `/ward project` Command (Persistent Project Rules)

Session grants (above) vanish when the session ends. `/ward project` is a separate, deliberately heavier-weight mechanism for a user who wants a rule to survive across sessions for one specific project — e.g. "this project should always be able to read that sibling directory." It writes an explicit, personal, project-scoped policy rule to disk, distinct in kind from session grants: it is authored policy, not a remembered runtime decision.

```
/ward project allow [read|write] <path>   # persist an allow rule for this project
/ward project deny  [read|write] <path>   # persist a deny rule for this project
/ward project list                        # show persisted global rules that apply to this project
```

**Storage — global config only, projectRoot-conditioned:**

A persisted rule is appended to the trusted global config's rule list, with a `projectRoot` condition set to the active session's exact canonical project root (same identity used elsewhere by `projectRoot` matching). It is never written to the project-local config — the project config is untrusted and self-authored policy must not live where a cloned repository could carry or tamper with it. This does not introduce a third store: there remain exactly two config files; `/ward project` is a controlled writer for one of them.

**Path handling:**

Only literal paths are accepted — same trailing-slash directory semantics as `/ward` (a trailing `/` covers the path and everything beneath it). No globs, no wildcards. The target path and the project root are canonicalized using the same resolution rules used when loading policy (absolute, symlinks resolved). When writing the rule, prefer expressing the target and the project-root condition in `~/`-relative form if that form's canonical identity is equivalent to the resolved path; otherwise fall back to the absolute canonical form.

**Confirmation is the persistence boundary:**

Writing to disk always requires an explicit interactive UI confirmation, shown before anything is written, displaying: the exact effect (allow/deny), the operation (read/write), the normalized target pattern, the project-root condition it will be scoped to, and the destination config. If no UI is available (headless/non-interactive), the command refuses outright and makes no change. This confirmation is intentionally separate from — and not triggered by — the ordinary runtime approval prompts described above; those grant session-only, in-memory access and never cause a disk write. Only this explicit `/ward project` confirmation can persist a rule.

**Ordering and shadowing:**

New rules are appended after all existing global rules — existing rules are never reordered. The checks below are evaluated against a freshly read and validated global config snapshot, obtained while holding the cooperative writer lock (see Safe write procedure), combined with the project rules currently loaded for this session — never against a global rule set cached from session start, which may be stale by the time of the write. If the on-disk global config changes between that snapshot and the atomic replace, the write aborts and is reported rather than proceeding against a snapshot known to be out of date; the rule list otherwise remains strictly append-only.

Before writing, the candidate rule is evaluated as if already appended at that trailing position against this snapshot plus the currently loaded project rules: if an earlier global rule would already match the same target and take precedence (shadowing the new rule), the write is rejected and nothing is persisted.

A persistent `allow` is additionally refused if the currently loaded effective policy already resolves the target to an explicit deny — including a project-config deny — rather than silently overriding it; the user must resolve that conflict by hand (e.g. editing the project config) rather than have `/ward project allow` paper over it. This refusal is a command-time UX safety policy only, not a change to runtime evaluation: runtime policy remains global-first as described throughout this design, so a hand-authored global `allow` for the same target would still take precedence over a project-config deny at runtime regardless of this command declining to add one on the user's behalf.

A persistent `deny`, by contrast, may freely supersede a later project-config rule for the same target, because the global config already has unconditional precedence over the project config by design. If the target currently matches a project-config `allow` (or other project rule) that the persistent deny will supersede, the confirmation prompt (see "Confirmation is the persistence boundary", above) explicitly surfaces that override — naming the currently-matching project rule and stating that the new global deny will take precedence over it — rather than persisting the change silently.

**`/ward project list`:**

Lists global rules whose `projectRoot` condition includes the active session's canonical project root — including rules that were hand-authored directly in the global config rather than written by this command. It is read-only and never mutates the config.

**Safe write procedure:**

Persisting a rule follows a careful update sequence so a crash or a concurrent ward-originated writer cannot corrupt the trusted global config: validate the config currently on disk; acquire an exclusive lock scoped to ward-originated writers and, if it is already held, fail immediately rather than wait; re-check that the on-disk content has not changed since it was read; validate the fully assembled proposed config (existing rules plus the new one); write the complete new config to a temporary file in the same directory, then atomically replace the original; preserve the original's restrictive file permissions on the replacement. If any step before the atomic replace fails, the original file is left untouched. A lock left behind by a crashed writer does not self-expire; recovery is manual (removing the stale lock) rather than an automatic timeout or takeover — this is deliberately simple rather than a general-purpose lock-recovery protocol. A non-cooperating external process writing to the same file outside this procedure remains out of scope, consistent with the existing external-process/TOCTOU boundary above.

**Reload after write:**

On a successful write, ward reloads the complete policy (both configs) for the current session so the new rule takes effect immediately where possible. If reload fails, the session keeps its previous in-memory policy running, and the user is told that the change was persisted to disk but requires a restart or manual repair to take effect — the command never claims the new rule is enforced immediately when reload did not succeed.

**Removal (initial scope):**

There is no `/ward project revoke` initially. Removing a persisted rule is manual: edit the global config directly. Persisted rules carry no managed identifier or provenance marker distinguishing command-written rules from hand-authored ones, and there is no cleanup pass for rules whose `projectRoot` no longer corresponds to an existing project (e.g. after a project directory moves) — `/ward project list` is the intended aid for a user auditing what is currently active for a project before editing the config by hand.

## Non-Goals

- **Bash command filtering** — pi-armory's responsibility.
- **Network access control** — out of scope.
- **Per-model or per-session rules** — single policy per directory tree.
- **Audit logging** — the TUI already shows blocked tool calls.
- **Overriding global rules from project config** — intentional. If a global deny is too broad, adjust the global config.
- **Recursive wildcards** — no `**` support. A directory pattern (`dir/`) covers the recursive case for access control purposes.
- **Per-project config store** — there are exactly two config files (global, project). No third, per-project store of grants; personal per-project scoping is expressed via a `projectRoot`-conditioned rule in the trusted global config instead.
- **Trust-on-first-use, signatures, or hashing** — configs are trusted or untrusted purely by which of the two fixed locations they were loaded from, never by verifying their content against a prior fingerprint.
- **Persistent approval database** — session grants (interactive approval, `/ward`, prompt-derived approval) are in-memory only and never written to disk across sessions. `/ward project` (above) is not an exception to this: it is not a general approval database either — it writes explicit, user-confirmed policy rules into the trusted global config, conditioned on the active project root, and never persists ordinary `/ward` session grants or ordinary interactive approval-prompt decisions; those remain in-memory only, exactly as described above.

## Key Invariants

1. A blocked operation never touches the filesystem.
2. Symlinks cannot bypass rules — real paths are always resolved.
3. Paths outside the project root are denied by default.
4. A config can only allow access at or below its own directory (enforced at match time).
5. Ward config files are always write-protected — by nominal `.pi/ward.json` structural path (including at creation) and by the canonical (realpath) identity of the configs actually loaded for the session, so symlinked ancestors or aliases cannot bypass the protection.
6. The project config is untrusted (it may ship inside a cloned repository): it can express policy within its own project root but can never expand authority beyond it or override/weaken a global rule.
7. Rules are pure data (JSON) — no executable logic in config.
8. Any config error fails closed — never fails open.
9. An empty or missing config results in the baseline policy (project-internal allowed, external denied).
10. Recursive read tools (`grep`; `find`/`ls` planned) execute, but result lines/entries attributable to a denied path are redacted from the output before the model sees them, fail-closed (unattributable output is dropped).
11. Ward's guarantees cover operations mediated through its guarded tools; actions taken outside that mediation (bash, external processes) are outside its boundary.
