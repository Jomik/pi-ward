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

Project baseline (inside the project root with no matching rule): full read/write access.

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
    terminal node the first rule names. `.pi/ward.id` remains blocked regardless, by
    self-protection.
- **`~/`** — anchored to the home directory. The home path is captured at config load time and used for matching. Can include path separators. Useful in the global config for targeting specific paths.
- **`/`** — absolute path anchor. Can include path separators. The leading literal segments are resolved via `realpath` at config load time to canonicalize symlinks (e.g., `/tmp/repos/` → `/private/tmp/repos/` on macOS). Useful for granting access to paths outside the home directory.
- **Trailing `/`** — directory match: the directory node itself and everything under it.
- **`*`** — wildcard within a single segment (does not cross `/`). Matches one or more characters. Prefix (`foo*`), suffix (`*.ext`), or both (`foo*.ext`).
- Unanchored patterns may contain `/` for multi-segment matching (see table above); interior empty segments (e.g. `.pi//PLAN.md`) are invalid.
- No `**`, no braces, no extglobs, no regex. Complexity is the enemy of a security boundary.
- Invalid pattern syntax is a load-time error.

### Configuration

Ward loads one declarative policy file:

- `~/.pi/agent/ward.json` — optional trusted global policy, scoped to the user's home directory.

ENOENT means an empty policy. Any other read, parse, schema, or pattern error fails closed. Rules evaluate top-to-bottom with first-match-wins semantics. There is no project-local policy file and no ancestor search. The former `<projectRoot>/.pi/ward.json` location and `projectRoot` rule condition are removed.

The global config can allow within `~` and deny any path. An absolute-anchored allow uses `/` as its trust scope and may therefore grant paths outside the home directory. An allow that can never take effect within its trust scope is a load-time error.

Example `~/.pi/agent/ward.json`:

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

### Persistent Project Grants

Persistent project grants are trusted, allow-only decisions stored outside the project:

```text
<projectRoot>/.pi/ward.id
~/.pi/agent/ward/<id>.grants.json
```

`ward.id` contains a randomly generated UUID. It is created lazily by the `/ward project` UI when the first grant is persisted; merely opening or listing a project does not create it. Agent worktrees that carry their gitignored `.pi` directory therefore carry the same identity and select the same grants regardless of their canonical root path. Ward does not inspect Git or Jujutsu metadata and does not derive identity from a repository path, remote, or commit.

The ID is a local bearer capability: possession selects its trusted grant file. It must remain local and gitignored. Ward validates the exact UUID syntax before using it as a filename, and guarded tools cannot read, create, modify, move, or delete any `.pi/ward.id`. Ward does not invoke Git or Jujutsu to verify ignore state. If an ID is committed or otherwise leaked, any project carrying that ID on the same machine inherits its grants; recovery is to revoke the grants, delete the old grants file, and generate a new ID. External processes and copying outside guarded tools remain outside Ward's threat model.

Ward's internal ID reader accepts only a small regular file at the exact nominal `<projectRoot>/.pi/ward.id` path, rejects symlinks and non-regular files, bounds the input size, and requires one canonical UUID plus optional trailing newline. Any other state fails closed.

The corresponding file under `~/.pi/agent/ward/` contains only literal grants:

```json
{
  "grants": [
    { "path": "~/.pi/agent/agents/", "operations": "read" },
    { "path": "/tmp/shared-output/", "operations": "write" }
  ]
}
```

- `path` is an absolute or `~/`-prefixed literal path. An existing directory is detected and granted recursively even without a trailing `/`; a trailing `/` requests directory scope for a path that does not yet exist. Globs and relative paths are rejected.
- `operations` is `"read"` or `"write"`; write implies read. It defaults to `"read"`.
- Every entry is an allow. Persistent project denies do not exist; persistent denies belong in the global policy, while temporary denies remain session-scoped.
- The grants file is trusted because it lives under the global agent directory and is writable only through Ward's confirmed management UI. The canonical grants path must remain beneath the canonical grants directory; symlink escapes fail closed. Ward creates the directory with mode `0700` and a new grants file with mode `0600`; replacing an existing grants file preserves its current mode with group/other write bits stripped, rather than always resetting to `0600`. The project ID cannot define or modify grants by itself.
- Missing `ward.id` or a missing grants file means no persistent project grants. A present but malformed/unreadable ID or grants file fails closed.
- Grant paths are resolved and canonicalized when loaded. Broken or unresolvable targets fail closed.

Persistent project grants are checked after session denies and before global policy. They may therefore carve an explicit, project-specific exception through an ordinary global deny such as `.pi/`. They never override path-resolution failures, Ward self-protection, or session denies.

No reverse index, project registry, VCS probing, or stale-project cleanup is maintained. The active project's `ward.id` is the complete lookup mechanism.

There is no automatic migration. `<projectRoot>/.pi/ward.json` is no longer loaded, `projectRoot` rules are rejected by the global schema, and users remove or recreate old policy manually.

### Path Resolution

Before matching, all paths are resolved:

- Paths are normalized and resolved to absolute form.
- Symlinks are resolved to their real path before matching — no symlink escapes.
- Broken symlinks (dangling, unresolvable) are denied.
- Matching is case-insensitive.

### Self-Protection

Ward protects policy authority by both nominal path and canonical file identity:

1. `~/.pi/agent/ward.json` and every `~/.pi/agent/ward/*.grants.json` are always write-protected from guarded tools, including before creation.
2. Every path structurally matching `<dir>/.pi/ward.id` is protected from both reads and writes, including before creation. The ID is consumed only by Ward internally.
3. The canonical device/inode identities of the active global policy, project ID, and grants file are captured when loaded and receive the same protection through symlink or hardlink aliases.

Nominal checks prevent pre-creation attacks; identity checks prevent aliasing attacks. Both are required. The `/ward project` management flow is the only sanctioned writer for `ward.id` and project grant files. It runs internally, never through guarded tools, and requires explicit interactive confirmation for every persistent mutation.

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

- **Invalid JSON / schema error in any config:** fail-closed. The extension remains loaded but enters an explicit fail-closed startup-error state: every guarded file operation is blocked and `/ward` refuses commands with a clear error until the config is repaired and the extension is reloaded or the session restarted.
- **Config file unreadable (permissions):** fail-closed, same startup-error state as above.
- **Extension crash during rule evaluation:** fail-closed. The tool call is denied.
- **Invalid pattern syntax:** fail-closed at load time.
- **Allow rule structurally out of scope:** load-time error (consistent with fail-closed).
- **`/ward project` write path (see [Safe write procedure](#ward-project-command-persistent-project-grants)):** a busy/stale lock, the on-disk source having changed since it was read, validation failure of the assembled grants file, or failure of the atomic replace step are all reported to the user as a failed write — none of these is ever presented as a successful persist.
- **`/ward project` post-write reload failure:** the disk write itself may have succeeded validly, but if reloading policy into the running session fails, the prior in-memory policy stays active for the rest of the session; the user is told the change is on disk but not yet enforced, and that a restart or manual repair is needed.

### Threat Model Scope

Ward's guarantees apply to operations mediated through its guarded tools (`read`, `grep`, `ls`, `find`, `write`, `edit`, `delete`, `move`). It checks policy before such a tool executes and does not control the tool's internal I/O implementation. Anything that reaches the filesystem outside that mediation — a bash command, an external process, or any other unguarded code path — is outside ward's boundary entirely, not merely unenforced within it; ward makes no claim about it one way or the other (bash is pi-armory's responsibility, see Non-Goals). Where the host extension framework's handler ordering or the ability of one extension to observe/mutate another's tool call is load-bearing for a guarantee above, that guarantee is only as strong as the host's assumptions on that point, not something ward independently verifies.

Concurrent filesystem mutation by processes outside the agent (TOCTOU via symlink swaps between check and tool execution) is outside the threat model — ward protects against the agent's own actions, not against a hostile local environment racing the filesystem.

The recursive-read output filter (see above) is inherently post-hoc: it `stat`-checks candidate paths *after* the tool produced its result. Its guarantee — a denied file's matched line is never surfaced — holds only when filesystem state is stable between tool execution and filtering. A same-prefix allowed file appearing (or a denied file disappearing) in that window could cause misattribution. This post-hoc race is an accepted limitation of redacting tool output, consistent with the TOCTOU scope above.

### Runtime Grants (Interactive Approval)

When a path is denied by baseline policy (outside project root, no explicit deny rule), ward prompts the user for approval via the TUI before blocking. This allows controlled access to external paths without pre-configuring rules.

The prompt summary shown to the user is tool-accurate rather than a generic `read/write <path>` line: `find`/`grep` show the search pattern and the search root (e.g. `grep needle in /some/dir`), `move` shows both source and destination (e.g. `move /a to /b`), and other guarded tools identify their action and target path directly.

**Prompt flow (two steps):**

When a baseline deny is triggered with a UI available, ward presents two sequential prompts:

1. **Action** — `"Deny"` / `"Approve"` (deny is first, fail-closed default)
2. **Scope** — options depend on the action and on whether the resolved target is a directory or a file:
   - Deny: `"Once"` / `"For session"`, regardless of target type.
   - Approve, target is a directory: `"Once"` / `"Allow <canonical resolved directory> for session"`.
   - Approve, target is a file: `"Once"` / `"Allow <canonical resolved file> for session"` / `"Allow <canonical parent directory> for session"`.

Each session-scope option's label spells out the canonical (symlink-resolved) path it would grant, rather than a generic "For session" choice — this surfaces any difference between the raw input path and its resolved target before the broader grant is recorded, so the user isn't blindly widening access to a path they didn't expect.

Combining these:

| Action | Scope | Effect |
|--------|-------|--------|
| Deny | Once | Block this call. Ask again on next attempt. |
| Deny | For session | Block and remember — suppress future prompts for this path. |
| Approve | Once | Allow this single call. No state stored. |
| Approve | Allow `<resolved file>` for session | Grant the exact file only — session-scoped, non-recursive. |
| Approve | Allow `<resolved directory>` for session | Grant the resolved directory and everything beneath it, recursively, for the session — offered when the target itself is a directory. |
| Approve | Allow `<parent directory>` for session | Grant the resolved file's parent directory and everything beneath it, recursively, for the session — offered as a broader alternative when the target is a file. |

If the user dismisses either prompt (e.g., Escape), the access is denied once without storing state.

**Evaluation order (checkPath + handler):**

1. Path resolution (symlink resolve, broken symlink check).
2. Self-protection check.
3. Check session denies → hard block.
4. Check explicit session grants (`/ward allow`) and the active project's persistent grants → allow on match. Both may override an ordinary global deny.
5. Evaluate global rules first-match-wins → allow or deny. An ungranted global deny blocks without an interactive prompt or prompt-derived approval; status says `explicit /ward allow required (no interactive prompt)`.
6. If baseline would deny (path outside project root):
   a. Check prompt-created session grants → if match, allow silently.
   b. If `--ward-no-prompts` is set, block without UI or prompt-derived approval.
   c. Otherwise, for reads only, check prompt-derived approval → if match, allow for the current turn.
   d. Otherwise, prompt user → apply their choice.
7. If baseline would allow (inside project root) → allow.

**Key constraints:**

- Interactive and `/ward` session grants are in-memory only. Persistent project grants are separate and managed only through `/ward project`.
- Explicit `/ward allow` session grants and persistent project grants can override ordinary global denies; interactive approval cannot. Call-scoped approvals remain baseline-only.
- Session denies are always stored and checked first. They override global rules, persistent project grants, session grants, baseline allows, and call-scoped approvals.
- Directory grants (`directory: true`) cover the path and everything under it.
- Operation semantics mirror rules: a write grant covers read+write; a read deny blocks both.
- When no UI is available (non-interactive mode), baseline denies remain blocked, except where prompt-derived read approval applies (see [Prompt-Derived Approval](#prompt-derived-approval-implicit-turn-scoped-grants) below) — that check needs no UI, only a real user turn.
- The boolean pi CLI flag `--ward-no-prompts` (default off) is read at the `tool_call` hook, not at extension initialization. When on, grantable baseline denies block before either implicit approval or the interactive UI (and before creating grep call-scoped approval context); `checkPath` still honors hard denies, global rule allows, explicit session grants, and persistent project grants.

### Prompt-Derived Approval (Implicit Turn-Scoped Grants)

Interactive approval and `/ward` both require the user to act out-of-band from their request. But often the user's own message already names the path they want read (e.g. "check @/tmp/notes/todo.md") — asking them to also click through a prompt is redundant. Prompt-derived approval treats a concrete matching path reference in the user's own message as consent for that reference, scoped to the turn in which it was made.

**Trigger:** only reached for a read that is otherwise grantable — i.e. baseline-denied (outside project root) with no persistent project grant, explicit deny rule, or resolution failure. It sits between the baseline deny and the interactive prompt in the evaluation order. Self-protected paths are rejected before this check.

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

The interactive approval flow prompts per-file. The `/ward` slash command lets the user proactively grant or deny access for the current session. Unlike prompt-created grants, explicit `/ward allow` grants can override ordinary global denies.

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

- Explicit `/ward allow` grants may override ordinary global deny rules as well as baseline denies, but not session denies, self-protection, or path-resolution failure. Prompt-created session grants and call-scoped approvals remain baseline-only.
- Denies: always stored, regardless of what a rule or baseline would otherwise decide — including paths inside the project root and paths an explicit rule would allow. A session deny is a hard temporary block for the remainder of the process: it overrides rule allows, baseline allows, session grants, and call-scoped approvals.
- Directory patterns: an existing directory is detected and granted recursively even without a trailing `/`; a trailing `/` requests directory scope for a path that does not yet exist, covering the path and everything underneath once it does.
- Operation semantics: `write` implies read+write for allow; for deny, `read` (default) blocks read+write, `write` blocks writes only. Omitting the operation defaults to `read`.
- Scope is always session — no persistence.
- Path resolution: `~/` expanded at grant time. Symlinks resolved. Relative paths resolved from project root.
- Literal paths and directory patterns only — no globs, no wildcards.

**Evaluation order:**

`/ward` grants and denies plug into the same evaluation order described in [Runtime Grants](#runtime-grants-interactive-approval):

1. Path resolution
2. Self-protection check
3. Session deny
4. Explicit session grant (`/ward allow`) or persistent project grant
5. Global rule evaluation; an ungranted global deny blocks without prompting
6. On baseline deny: prompt-created session grant, then if `--ward-no-prompts` is set block; otherwise prompt-derived approval, then interactive prompt
7. Baseline allow

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

### `/ward project` Command (Persistent Project Grants)

`/ward project` manages the active project's allow-only persistent grant file. Users never need to locate or edit the UUID-named file manually.

Direct commands remain available:

```text
/ward project allow [read|write] <path>
/ward project list
/ward project revoke <path>
```

Running `/ward project` without arguments opens an interactive manager:

```text
Project grants
  read   ~/.pi/agent/agents/   directory
  write  ~/notes/output.md     file

[Add grant] [Revoke grant] [Close]
```

**Add flow:** select read or write, enter a literal path, resolve it, determine file/directory scope, then show a confirmation containing the normalized path, operation, project-specific scope with a short project ID, and any ordinary global deny the grant will override. The short ID is the prefix of the corresponding grants filename. The first confirmed grant creates both the random project ID and its grants file. Cancellation or absence of an interactive UI leaves disk unchanged.

**Revoke flow:** select an existing grant, then confirm its removal. Removing the final grant deletes the empty grants file but retains `ward.id`, so all worktrees keep a stable identity. Revocation affects only persistent project grants; `/ward revoke` remains session-only.

**Path handling:** only literal paths are accepted. `~/` and absolute paths are supported; relative paths are resolved from the project root for command input but persisted canonically as `~/` or absolute paths. An existing directory is detected and granted recursively even without a trailing `/`; a trailing `/` requests directory scope for a path that does not yet exist. Globs and wildcards are rejected.

**Override semantics:** a persistent project grant is an explicit trusted exception. The confirmation UI must clearly name an ordinary global deny it overrides. It cannot target a self-protected path, override a session deny, or bypass path-resolution failure. Duplicate grants are rejected; a broader existing grant is shown instead of adding a redundant entry.

**Safe write procedure:** reads and validates the current grants file, acquires an exclusive fail-fast lock for that file, verifies the source did not change, validates the proposed complete file, writes a sibling temporary file, and atomically replaces the destination while preserving restrictive permissions. Creating `ward.id` and the first grants file is ordered so an interruption can leave at worst an unused ID or an orphaned grants file, never a partially valid authority file. Stale locks require manual removal.

**Reload after write:** after a successful add or revoke, Ward reloads the active grants file. If reload fails, the prior in-memory grants remain active and the UI reports that the disk change requires restart or repair.

## Non-Goals

- **Bash command filtering** — pi-armory's responsibility.
- **Network access control** — out of scope.
- **Per-model policy** — one global policy and one active project grant set apply to the session.
- **Audit logging** — the TUI already shows blocked tool calls.
- **Project-local policy** — `<projectRoot>/.pi/ward.json` is unsupported. Projects carry only an opaque local identity; authority remains under `~/.pi/agent/`.
- **Persistent project denies** — project files are allow-only. Put persistent denies in global policy or use session denies.
- **VCS identity discovery** — no Git/Jujutsu subprocesses, repository-root hashes, remote URLs, or commit-derived IDs.
- **Project registry and cleanup** — no reverse index or automatic garbage collection of orphaned grants files.
- **Recursive wildcards** — no `**` support. A directory path covers the recursive case.
- **Automatic persistence of runtime approval** — interactive approval, prompt-derived approval, and `/ward allow` remain session/turn scoped. Only `/ward project` persists.

## Key Invariants

1. A blocked operation never touches the filesystem, except the documented post-execution nature of recursive-read filtering.
2. Symlinks cannot bypass rules or grants — real paths are always resolved.
3. Paths outside the project root are denied by default.
4. The sole declarative policy file is the trusted global `~/.pi/agent/ward.json`; projects cannot supply policy.
5. Persistent project grants are allow-only, stored under `~/.pi/agent/ward/`, and selected by a random local project ID.
6. A project ID carries no authoring authority: it can select only the already-existing trusted grants file with that exact ID.
7. Explicit `/ward allow` session grants and persistent project grants may override ordinary global denies, but never resolution failures, self-protection, or session denies; prompt-created and call-scoped approvals remain baseline-only.
8. Global policy and grants files are write-protected from guarded tools. `.pi/ward.id` is protected from both reads and writes, including before creation; canonical identity checks prevent alias bypasses.
9. Rules and grants are pure data — no executable logic.
10. Any active policy, identity, or grants-file error fails closed.
11. Missing policy or grants result in baseline behavior: project-internal access allowed, external access denied.
12. Recursive read tools (`grep`; `find`/`ls` planned) execute, but result lines/entries attributable to a denied path are redacted before the model sees them, fail-closed.
13. Ward's guarantees cover operations mediated through its guarded tools; bash and external processes remain outside its boundary.
