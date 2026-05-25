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

## Config

Rules are loaded from `~/.pi/agent/ward.json` (global) and `.pi/ward.json` files along the directory tree. Global rules always take precedence — inner configs can't weaken outer ones.

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

### Operations

The `operations` field controls the access level a rule grants or restricts. It defaults to `"read"` (restrictive).

| effect | operations | Result |
|--------|------------|--------|
| `allow` | `"read"` (default) | Grants read access only |
| `allow` | `"write"` | Grants full access (read + write) |
| `deny` | `"read"` (default) | Denies all access |
| `deny` | `"write"` | Denies writes only (read-only) |

Rules are evaluated top-to-bottom, first match wins. See [DESIGN.md](./DESIGN.md) for pattern syntax, trust scoping, and the full specification.

## Design

See [DESIGN.md](./DESIGN.md) for the full specification.
