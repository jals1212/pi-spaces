---
name: pi-spaces
description: "Trigger: pi-spaces, space, spaces, /space, pi-space, pi --space, PI_SPACE, PI_SPACE_HOME, PI_SPACES_COMMAND, PI_SPACES_SETUP, which space, agent home, base home, update, install, uninstall, setup. Know which Pi space this session runs in, its home and start command, and how spaces and their packages are listed, created, set up, updated, switched and removed."
license: MIT
metadata:
  author: jals1212
  version: "1.0"
---

## Activation Contract

Use when a task depends on which Pi agent home this session uses (settings, sign-ins, installed packages, sessions), or when the user asks about spaces. A space is a separate Pi agent home kept in a folder of the spaces folder; the base home is the one Pi started with. Pi reads its home once at startup, so one process stays in one space.

## Hard Rules

- Read where you run from the `<pi_space>` system prompt section; in a shell, from `PI_SPACE` (unset in the base home), `PI_SPACE_HOME` (this Pi's agent home) and `PI_SPACES_COMMAND` (the program that starts Pi, default `pi`). Never guess from `~/.pi/agent`.
- Files of this session's home (`settings.json`, `extensions/`, `sessions/`, installed packages) live under `PI_SPACE_HOME`; `pi install` and settings changes apply to this space only.
- Never read `auth.json` or other credential files in any home.
- You cannot move this session to another space. Ask the user to run `/space switch <name>` (interactive terminal only; Pi restarts), or start another Pi with `$PI_SPACES_COMMAND --space <name>`.
- Never set `PI_CODING_AGENT_DIR` yourself, and never create, rename or delete space folders with file commands; use `/space` or `pi-space`.
- Removing a space deletes everything in it: only on the user's explicit request, and keep the backup unless they say otherwise.

## Decision Gates

| Need | Action |
| --- | --- |
| Which space, home, command | `<pi_space>` section, or `echo "$PI_SPACE|$PI_SPACE_HOME|$PI_SPACES_COMMAND"` |
| List spaces from a shell | `pi-space list` (optional `@jals1212/pi-spaces-cli`) |
| Spaces folder | `PI_SPACES_DIR`, else `spaces` next to the base home (`PI_SPACES_BASE_HOME`, else this home) |
| Create a space | `pi-space new <name>`, or ask the user for `/space new <name>`; `pi-space new` also runs the setup command when there is one (`--setup <cmd>` or `PI_SPACES_SETUP`) |
| Prepare a space for the program that runs Pi | `pi-space setup <name|--every>`: runs the setup command (`{home}` and `{name}` become the space's folder and name) with the space as `PI_CODING_AGENT_DIR`; never in base |
| Work in another space | User runs `/space switch <name>`, or `$PI_SPACES_COMMAND --space <name> "<prompt>"` |
| Remove a space | User request only: `pi-space remove <name> --yes` keeps a backup in `.backups` |
| Packages of a space | `pi-space update <name|base|--every> --extensions`, `pi-space install <name> <source>`, `pi-space uninstall <name> <source>`, `pi-space list <name>`; without the CLI, `$PI_SPACES_COMMAND --space <name|base> update --extensions` |

Names: lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters; `base` (the base home) and the command words (`list`, `new`, `remove`, `rename`, `switch`, `update`, `install`, `uninstall`, `setup`) are reserved.

## Execution Steps

1. Read the `<pi_space>` section or the three variables before touching any home file.
2. Pick the action from Decision Gates; prefer telling the user the `/space` command when it needs the interactive terminal.
3. Report the space and home you acted on.

## Output Contract

State the space (or "base home"), the agent home path, and the command or `/space` action used or proposed.

## References

- `../../README.md` — commands, environment variables and how switching works.
