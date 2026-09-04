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

## Why

- Prevents the agent from reading secrets (`.env`, `.pem`, credentials)
- Blocks writes outside the project tree
- Stops accidental modification of `.git` internals
- Symlink-aware — no escape via symlink tricks
- Config-file self-protection — the agent can't weaken its own constraints
- Fail-closed on any error — never fails open

## How it works

pi-ward intercepts file operations (`read`, `write`, `edit`) before they execute. It evaluates declarative rules from ward config files against the resolved real path.

**Baseline policy** (no config needed):

- Read/write within project root: allowed
- Any access outside project root: denied

When a path outside the project root is accessed and no explicit deny rule matches, ward prompts for approval (if a UI is available). You can approve or deny, scoped to a single attempt or the entire session. Alternatively, a read of an otherwise-grantable external path may be silently approved for the current turn when the user's latest own message references the path — existing files may be referenced bare or with `@` (exact file only, no subtree), while an `@`-marked existing directory reference also authorizes reads of anything existing beneath it, since bare directory mentions are too ambiguous to trust and directory tools may recurse. This approval is read-only, non-persistent, works without a UI, and never overrides explicit deny rules. See [DESIGN.md](./DESIGN.md#prompt-derived-approval-implicit-turn-scoped-grants) for the exact grammar.

## Config

Rules are loaded from exactly two locations: `~/.pi/agent/ward.json` (global) and `<projectRoot>/.pi/ward.json` (project). Global rules are loaded first and always take precedence — the project config cannot weaken the global config.

Example `.pi/ward.json`:

```json
{
  "rules": [
    { "pattern": ".env*", "effect": "deny" },
    { "pattern": "*.pem", "effect": "deny" },
    { "pattern": ".git/", "operations": "write", "effect": "deny" },
    { "pattern": ".secret/", "effect": "deny" }
  ]
}
```

Absolute-path patterns (starting with `/`) can be used in `~/.pi/agent/ward.json` to grant access to paths outside `~`:

```json
{
  "rules": [
    { "pattern": "/tmp/pi-github-repos/", "effect": "allow" }
  ]
}
```

### Operations

The `operations` field controls the access level a rule grants or restricts. It defaults to `"read"` (restrictive).

| effect | operations | Result |
|--------|------------|--------|
| `allow` | `"read"` (default) | Grants read access only |
| `allow` | `"write"` | Grants full access (read + write) |
| `deny` | `"read"` (default) | Denies all access |
| `deny` | `"write"` | Denies writes only (read-only) |

Rules are evaluated top-to-bottom, first match wins. See [DESIGN.md](./DESIGN.md) for pattern syntax, trust scoping, and the full specification.

### Persistent project rules: `/ward project`

Ordinary `/ward allow`, `/ward deny`, `/ward list`, and `/ward revoke` only affect the current session — they grant or block access temporarily and vanish when the session ends. Approval prompts (accept/deny a single access) are likewise non-persistent.

`/ward project allow|deny|list` instead writes a durable, personal rule that survives across sessions:

```
/ward project allow [read|write] <path>
/ward project deny [read|write] <path>
/ward project list
```

- The rule is always written to the trusted global config, `~/.pi/agent/ward.json` — **never** to the repository-local `<projectRoot>/.pi/ward.json`. It is scoped with an exact `projectRoot` condition matching the current project, so it only applies here.
- `<path>` is a literal path, not a glob. A trailing slash marks it as a directory (matching the path and everything beneath it); without one, only the exact file is matched.
- Persisting requires an interactive session — you'll see an exact preview of the rule (effect, operation, pattern, `projectRoot`, destination file) and must explicitly confirm before anything is written.
- Rules are append-only: if an earlier global rule would already shadow the new one, the command refuses and tells you so instead of persisting a no-op. A persisted deny that would supersede an existing project-local rule reports that conflict as an informational note, but still proceeds. `/ward project allow` itself refuses to persist when an existing explicit deny — global or project-local — currently governs the target; it never silently overrides that deny.
- On success, the in-memory policy is reloaded immediately so enforcement and `/ward status` reflect the change right away. If reloading fails (e.g. the config is now malformed), the write to disk still succeeded, but you must restart the agent to apply it — the command warns you when this happens.
- `/ward project list` shows only rules scoped to the current project's `projectRoot`.
- There is no `/ward project revoke` — remove a persisted rule by editing `~/.pi/agent/ward.json` directly.
- Persisting takes a cooperative lock (`~/.pi/agent/ward.json.lock`) to avoid concurrent writers. If a previous write crashed and left a stale lock behind, `/ward project` will refuse with "another ward policy write is already in progress" — delete `~/.pi/agent/ward.json.lock` manually, but only once you've confirmed no other write is actually in progress.

### Project-Root–Scoped Rules (Global Config Only)

Global rules may include a `projectRoot` field (string or string array) to restrict the rule to specific projects. A rule with `projectRoot` is only evaluated when the active session's project root exactly matches:

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

This allows `backend` to read `~/projects/shared-lib/` while any other project is denied by baseline. Pass an array to apply the same rule to multiple projects. Project configs may not use `projectRoot` — it is a load-time error. See [DESIGN.md](./DESIGN.md) for path resolution semantics and further examples.

## `/ward` Session Controls

The `/ward` slash command manages in-memory, session-scoped access decisions on top of the config rules above:

```
/ward allow read <path>    # grant read for this session
/ward allow write <path>   # grant read+write for this session
/ward deny <path>          # hard session block, default read (blocks read+write)
/ward deny write <path>    # hard session block, write only (read still permitted)
/ward list                 # show active session decisions
/ward revoke <path>        # remove a session decision, reverting to baseline/rules
/ward status <path>        # show what rule/grant/deny applies to a path and why
```

Operations default to `read` (restrictive) — same asymmetric semantics as config rules: `allow write` grants read+write, `deny` (read) blocks both, `deny write` blocks writes only. A `/ward deny` is a hard, temporary block for the rest of the session: it applies even inside the project root and overrides allows (rule allows, baseline allows, and other session grants). See [DESIGN.md](./DESIGN.md#ward-command-proactive-session-grants) for evaluation order and precedence details.

## Design

See [DESIGN.md](./DESIGN.md) for the full specification.
