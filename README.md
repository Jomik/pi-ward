# pi-ward

File access guard for [pi](https://github.com/earendil-works/pi). Declarative filesystem boundaries for the coding agent.

## Installation

```bash
pi install npm:pi-ward
```

Or try without installing:

```bash
pi -e npm:pi-ward
```

To block otherwise-grantable outside-project access without approval prompts or implicit approval from user messages:

```bash
pi --ward-no-prompts -e npm:pi-ward
```

This session flag defaults to off. It does not disable explicit global rule allows, `/ward` session grants, or persistent project grants; hard denies still apply. It only disables interactive approval and prompt-derived read approval (including `@`-marked directory references).

## Why

- Prevents the agent from reading secrets (`.env`, `.pem`, credentials)
- Blocks writes outside the project tree
- Stops accidental modification of `.git` internals
- Symlink-aware — no escape via symlink tricks
- Config-file self-protection — the agent can't weaken its own constraints
- Fail-closed on any error — never fails open

## How it works

pi-ward intercepts file operations (`read`, `write`, `edit`, `delete`, `move`, and the recursive `grep`/`find`/`ls` tools) before they execute. It evaluates declarative rules from the ward config against the resolved real path.

**Baseline policy** (no config needed):

- Read/write within the project root: allowed
- Any access outside the project root: denied

By default, when a path outside the project root is accessed and no explicit deny rule matches, ward prompts for approval (if a UI is available). You can approve or deny, scoped to a single attempt or the entire session. When approving a file (rather than a directory), you can choose to grant just that exact file for the session, or the broader parent directory (and everything beneath it) for the session. Alternatively, a read of an otherwise-grantable external path may be silently approved for the current turn when the user's latest own message references the path — existing files may be referenced bare or with `@` (exact file only, no subtree), while an `@`-marked existing directory reference also authorizes reads of anything existing beneath it, since bare directory mentions are too ambiguous to trust and directory tools may recurse. This approval is read-only, non-persistent, works without a UI, and never overrides explicit deny rules. See [DESIGN.md](./DESIGN.md#prompt-derived-approval-implicit-turn-scoped-grants) for the exact grammar.

## Config

Ward loads exactly one declarative policy file: `~/.pi/agent/ward.json` (global). There is no project-local policy file, no ancestor search, and no `projectRoot` rule condition — projects cannot supply or weaken policy.

Example `~/.pi/agent/ward.json`:

```json
{
  "rules": [
    { "pattern": ".env*", "effect": "deny" },
    { "pattern": "*.pem", "effect": "deny" },
    { "pattern": ".git/", "operations": "write", "effect": "deny" },
    { "pattern": "~/.ssh/", "effect": "deny" }
  ]
}
```

Absolute-path patterns (starting with `/`) can be used to grant access to paths outside `~`:

```json
{
  "rules": [
    { "pattern": "/tmp/pi-github-repos/", "effect": "allow" }
  ]
}
```

Unanchored patterns may span multiple segments (e.g. `.pi/PLAN.md`). Without a trailing `/`, the
segment sequence must match the *terminal* node at the very end of the path (not a directory and
not a path that continues beyond it); with a trailing `/`, it matches that directory sequence
anywhere in the path plus everything beneath it — same as a single-segment directory pattern.
This lets the agent maintain specific files inside an otherwise-protected directory:

```json
{
  "rules": [
    { "pattern": ".pi/PLAN.md", "operations": "write", "effect": "allow" },
    { "pattern": ".pi/DESIGN.md", "operations": "write", "effect": "allow" },
    { "pattern": ".pi/", "operations": "write", "effect": "deny" }
  ]
}
```

Here `.pi/PLAN.md` and `.pi/DESIGN.md` remain writable; every other write under `.pi/`, including
`.pi/PLAN.md/child`, is denied — and `.pi/ward.id` remains blocked regardless, by
self-protection (ward's writable identity/grants authority lives under `~/.pi/agent/`, not
inside the project).

### Operations

The `operations` field controls the access level a rule grants or restricts. It defaults to `"read"` (restrictive).

| effect | operations | Result |
|--------|------------|--------|
| `allow` | `"read"` (default) | Grants read access only |
| `allow` | `"write"` | Grants full access (read + write) |
| `deny` | `"read"` (default) | Denies all access |
| `deny` | `"write"` | Denies writes only (read-only) |

Rules are evaluated top-to-bottom, first match wins. See [DESIGN.md](./DESIGN.md) for pattern syntax, path resolution, and the full specification.

## Persistent Project Grants: `/ward project`

Ordinary `/ward allow`, `/ward deny`, `/ward list`, and `/ward revoke` only affect the current session — they vanish when the session ends. `/ward project` instead manages a durable, **allow-only** grant set scoped to the current project, stored outside the project tree.

**How it's identified:** the first time a grant is persisted, ward creates `<projectRoot>/.pi/ward.id` — a random UUID — and writes the grant to `~/.pi/agent/ward/<id>.grants.json`. The project directory itself carries no policy; it carries only an opaque local identity that selects a trusted file under `~/.pi/agent/`. `.pi/ward.id` must be gitignored — ward does not add it to `.gitignore` for you, and does not inspect Git/Jujutsu state at all. If the ID is ever committed or otherwise leaked, any project carrying that same ID on the same machine inherits its grants; recover by revoking the grants, deleting the grants file, and letting a fresh grant regenerate the ID.

**Usage:**

```
/ward project allow [read|write] <path>
/ward project list
/ward project revoke <path>
/ward project              # opens an interactive manager (list, add, revoke)
```

- `<path>` is a literal path, not a glob. `~/` and absolute paths are supported; a relative path is resolved from the project root. An existing directory is always detected and granted recursively, whether or not `<path>` ends in `/`. A trailing `/` is how you request directory scope for a path that doesn't exist yet; without a trailing slash, a not-yet-existing path is granted as an exact file.
- Persisting requires an interactive session with confirmation support — you'll see the operation, path, project-specific scope with a short project ID, and any ordinary global deny rule the grant will override. The short ID is the prefix of the corresponding grants filename under `~/.pi/agent/ward/`. Cancelling, or running without an interactive UI, leaves disk unchanged.
- Grants are allow-only. There is no persistent project deny — `/ward project deny` is rejected; use a global deny rule for a durable block, or `/ward deny` for a session-scoped one.
- A persistent project grant may override an ordinary global deny rule (it's reported in the confirmation preview), but it can never target a self-protected path, override a session deny, or bypass a path-resolution failure.
- Duplicate or already-covered grants are rejected — an exact repeat, or a request already covered by a broader existing grant, is reported instead of adding a redundant entry.
- On success, the in-memory policy is reloaded immediately so enforcement and `/ward status` reflect the change right away. If reloading fails (e.g. the resulting grants file is somehow invalid), the write to disk still succeeded, but you must restart the agent to apply it — the command tells you this.
- `/ward project revoke <path>` removes a persisted grant for an exact path (requires confirmation). Removing the last grant for a project deletes the grants file but keeps `ward.id`, so the project keeps a stable identity for any future grant.
- `/ward project list` shows only the active project's persistent grants.
- Writes are protected by a cooperative lock (a sibling `<id>.grants.json.lock` file). If a previous write crashed and left a stale lock behind, `/ward project` refuses with "another ward grants write is already in progress" — delete the `.lock` file manually, but only once you've confirmed no other write is actually in progress.
- `~/.pi/agent/ward/` is created with mode `0700`; a new grants file is created with mode `0600`. Replacing an existing grants file preserves its current mode with group/other write bits stripped, rather than always resetting to `0600`.

There is no automatic migration from an older project-local `<projectRoot>/.pi/ward.json` or `projectRoot`-scoped global rule — both are no longer loaded/accepted at all. If you were using either, remove the old project config file and/or delete the `projectRoot`-scoped rules from your global config manually; recreate the equivalent access as global rules or `/ward project` grants.

## `/ward` Session Controls

The `/ward` slash command manages in-memory, session-scoped access decisions on top of the config rules above:

```
/ward allow read <path>    # grant read for this session
/ward allow write <path>   # grant read+write for this session
/ward deny <path>          # hard session block, default read (blocks read+write)
/ward deny write <path>    # hard session block, write only (read still permitted)
/ward list                 # show active session decisions
/ward revoke <path>        # remove a session decision, reverting to baseline/rules/persistent grants
/ward status <path>        # show what rule/grant/deny applies to a path and why
```

As with persistent project grants, a `<path>` given to `/ward allow`/`/ward deny` is detected as a directory (recursive) whenever it resolves to an existing directory, even without a trailing `/`; a trailing `/` is how you request directory scope for a path that doesn't exist yet.

Operations default to `read` (restrictive) — same asymmetric semantics as config rules: `allow write` grants read+write, `deny` (read) blocks both, `deny write` blocks writes only. A `/ward deny` is a hard, temporary block for the rest of the session: it applies even inside the project root and overrides everything else — rule allows, baseline allows, persistent project grants, and other session grants. `/ward revoke` only ever removes a *session* decision; it has no effect on persistent project grants (use `/ward project revoke` for those). See [DESIGN.md](./DESIGN.md#ward-command-proactive-session-grants) for evaluation order and precedence details.

## Design

See [DESIGN.md](./DESIGN.md) for the full specification.
