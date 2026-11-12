---
name: pi-spaces
description: "Trigger: pi-spaces, space, spaces, /space, pi-space, pi --space, PI_SPACE, PI_SPACE_HOME, PI_SPACES_COMMAND, PI_SPACES_SETUP, PI_SPACES_CONFIG, profile, which space, agent home, base home, migrate, update, install, uninstall, setup. Know which Pi space this session runs in, its home and start command, and how spaces and their packages are listed, created, set up, updated, switched and removed."
license: MIT
metadata:
  author: jals1212
  version: "1.10"
---

## Activation Contract

Use when a task depends on which Pi agent home this session uses (settings, sign-ins, installed packages, sessions), or when the user asks about spaces. A space is a root folder in the spaces folder with its own Pi agent home, `agent`, inside it (`<spaces folder>/<name>/agent`, `PI_SPACE_HOME`); an old space made before that layout has no `agent/` folder and its folder is its agent home. The base home is the one Pi started with. A profile (an entry of the optional config file) describes a program that runs Pi: its base home, commands (`base`, `space`, `setup`), spaces folder and per-space variables. Pi reads its home once at startup, so one process stays in one space.

## Hard Rules

- Read where you run from the `<pi_space>` system prompt section; in a shell, from `PI_SPACE` (unset in the base home), `PI_SPACE_HOME` (this Pi's agent home) and `PI_SPACES_COMMAND` (the program that starts Pi, default `pi`). Never guess from `~/.pi/agent`.
- The `pi-space` CLI names every space `<profile>/<name>` (`base` included, as `<profile>/base`); a bare name is refused. Nothing in the environment or the `<pi_space>` section names your own profile. To find it, take your base home (`PI_SPACES_BASE_HOME` when set, else `PI_SPACE_HOME`) and look in the config file for the profile whose `home` is that folder; no match means the built-in `pi`.
- Files of this session's home (`settings.json`, `extensions/`, `sessions/`, installed packages) live under `PI_SPACE_HOME`, which is `<space>/agent` for a space with that layout; what a program keeps per space beside `agent/` is under the space's root folder (`{space}`); `pi install` and settings changes apply to this space only.
- The config's `default` is not used by `pi-space` (it warns and ignores it); the profile is always named. `pi-space` does not read `PI_SPACES_COMMAND`, `PI_SPACES_DIR` or `PI_SPACES_SETUP` from the shell: a profile or `--command`, `--dir`, `--setup` (for one named profile) gives them.
- Profiles live in the file in `PI_SPACES_CONFIG`, else the first that exists of `config.toml` and `config.json` in `~/.config/pi-spaces` (`$XDG_CONFIG_HOME/pi-spaces` when that is an absolute path), then in `~/.pi-spaces`; else `~/.pi-spaces/config.toml` (a `config.json` next to the `config.toml` that is read is ignored, with a warning). A path ending in `.toml` is TOML, any other JSON, with the same keys; its `schema` must be `pi-spaces.config/v1` or `pi-spaces.config/v2` (v2 is the current one: a profile has `home`, `commands`, `dir`, `spaceEnv`; v1 has `command`, `setup`, `homeless` instead of `commands`). TOML takes `#` comments, JSON `//` and `/* */`. `pi-space init` writes a starter v2 file in TOML (JSON for a `--config` path not ending in `.toml`; refuses an existing one). Read it to answer questions about profiles; edit it only when the user asks, and keep every key to the documented ones (unknown keys make the file invalid and ignored).
- Never read `auth.json` or other credential files in any home.
- You cannot move this session to another space. Ask the user to run `/space switch <name>` (interactive terminal only; Pi restarts: with a v2 profile it runs the profile's `commands`, else the running Pi starts again), or start another Pi with `$PI_SPACES_COMMAND --space <name>` (the space name there is bare: `work`; `pi-space` takes `<profile>/work`), only when `PI_SPACES_COMMAND` has no `{home}` and no `{name}`; when it has one (`my-launcher --home {home}`, `pi --space {name}`) the command is a template, not run through `--space`: use `pi-space <profile>/<name>`. The program's own commands (`upgrade`, `--version`) go through `pi-space <profile>/<name> <command>`.
- The Pi that `pi-space` starts runs as if started from a plain terminal for the named profile, even when you run it from inside another Pi or a space (it unwinds your space and sets `PI_CODING_AGENT_DIR` to that profile's home).
- Never set `PI_CODING_AGENT_DIR` yourself, and never create, rename or delete space folders with file commands; use `/space` or `pi-space`.
- Removing a space deletes everything in it: only on the user's explicit request, and keep the backup unless they say otherwise.

## Decision Gates

| Need | Action |
| --- | --- |
| Which space, home, command | `<pi_space>` section, or `echo "$PI_SPACE|$PI_SPACE_HOME|$PI_SPACES_COMMAND"` |
| List spaces from a shell | `pi-space list` (optional `pi-spaces-cli`): every profile, each space as `<profile>/<name>` |
| Spaces folder | `PI_SPACES_DIR`, else the `dir` of the profile whose `home` is the base home, else `spaces` next to the base home (`PI_SPACES_BASE_HOME`, else this home) |
| Profiles, or why a variable differs per space | The config file (`PI_SPACES_CONFIG`, else `config.toml` or `config.json` in `~/.config/pi-spaces`, then in `~/.pi-spaces`): a profile's `spaceEnv` variables are set only inside spaces (`{home}` the agent home, `{space}` the space's root folder and `{name}` filled in) and removed in base; without `spaceEnv` whatever a program keeps outside its agent home is shared with base |
| Pick a space from a shell | bare `pi-space` on a terminal opens a picker of every profile's spaces (`<profile>/<name>`, `base` included) and starts Pi in the one chosen |
| Pin a space to a repository (like `.nvmrc`) | `pi-space pin <profile>/<name>` writes `.pi/pi-space/space` (one line `<profile>/<name>`) and a self-ignoring `.pi/pi-space/.gitignore` in the git root; a bare `pi-space` there or below then starts that space at once (a space named on the command line wins; `pi-space pick` opens the picker); `pi-space pin` alone opens a picker to choose it on a terminal (the pinned space marked `⌂`), `pi-space pin --show` prints it, `pi-space unpin` removes it. From inside Pi, the user can pin this session's own space with `/space pin` and remove it with `/space unpin`. Only `pi-space` reads the marker; Pi and `/space switch` do not |
| Rename a space | User request only: `pi-space rename <profile>/<old> <new>`; the new name alone or with the same profile (`<profile>/<new>`), a space never changes profile; refused for base and for the space you are in |
| Create a space | `pi-space new <profile>/<name>`, or ask the user for `/space new <name>` (this Pi's profile); `pi-space new` also runs the profile's setup command when there is one (or `--setup <cmd>` for one call), and asks whether the space declares the extension: pass `--extension` or `--no-extension` when running it for the user, since there is no terminal to answer |
| Prepare a space for the program that runs Pi | `pi-space setup <profile>/<name>` (or `<profile>/base`, `<profile>/--every` for base then its spaces, or `--every` for the base and spaces of every profile with a setup, which pi has not by default; the profile's `commands.setup`): runs the setup command (`{home}` becomes the space's agent home, `{space}` its root folder and `{name}` its name) with the agent home as `PI_CODING_AGENT_DIR`; in base `{home}` is the profile's home and `{name}` is `base` |
| Work in another space | User runs `/space switch <name>` (with a v2 profile it runs `commands.space`, or `<commands.base> --space <name>`; `/space switch base` runs `commands.base`; otherwise Pi starts again), or `$PI_SPACES_COMMAND --space <name> "<prompt>"` (only when the command has no `{home}` or `{name}`), or `pi-space <profile>/<name>` from a shell |
| Give an old space the `agent/` layout | User request only: `pi-space migrate <profile>/<name>` (or `<profile>/--every`, `--every`): copies the space to `.backups`, then moves its content into `<space>/agent/`; refuses base, the space you are in and a space that already has `agent/` |
| Remove a space | User request only: `pi-space remove <profile>/<name> --yes` keeps a backup in `.backups` |
| The program's own command (e.g. `--version`, `upgrade`) through a profile | `pi-space <profile>/base <command>` runs the profile's `commands.base` as it is, with the command after it and no `--space`: with `"base": "my-launcher"`, `pi-space launcher/base upgrade` → `my-launcher upgrade`. In a space, only when `commands.space` has `{home}` (e.g. `"my-launcher --home {home}"`): `pi-space <profile>/<name> <command>` runs that with `{home}` filled in, with no `--space`, and it works only when the program accepts the command after its home option. In a v1 file the profile has `command` (with `{home}`) and `homeless` words (`"homeless": ["upgrade"]`) run it without its home part. Otherwise tell the user to run such a command directly |
| Packages of a space | `pi-space update <profile>/<name|base|--every> --extensions` (`--every` alone: every profile; they go through the profile's commands: `pi-space update launcher/base` → `my-launcher update`), `pi-space install <profile>/<name> <source>`, `pi-space uninstall <profile>/<name> <source>`, `pi-space list <profile>/<name>`; without the CLI, `$PI_SPACES_COMMAND --space <name|base> update --extensions` |

Names (the part after `<profile>/`; a profile name follows the same rule): lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters; `base` (the base home) and the command words (`list`, `new`, `remove`, `rename`, `switch`, `update`, `install`, `uninstall`, `setup`, `completion`) are reserved.

## Execution Steps

1. Read the `<pi_space>` section or the three variables before touching any home file.
2. Pick the action from Decision Gates; prefer telling the user the `/space` command when it needs the interactive terminal.
3. Report the space and home you acted on.

## Output Contract

State the space (or "base home"), the agent home path, and the command or `/space` action used or proposed.

## References

- `../../README.md` — commands, environment variables, the profiles file (schema, `spaceEnv`) and how switching works.
