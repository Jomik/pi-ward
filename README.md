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

## Design

See [DESIGN.md](./DESIGN.md) for the full specification.
