# pi-spaces

Named spaces for [Pi](https://pi.dev): keep several agent homes side by side and switch between them from inside Pi.

A space is a complete Pi agent home: its own sign-ins, packages, settings, skills and sessions. Use one per client, per experiment, or to try a package without touching your everyday setup.

```text
/space new work          Created space "work" at ~/.pi/spaces/work.
/space                   Switch to space
                         → base
                           work
                         Pi restarts in "work"; the status line shows space: work
```

It relies only on Pi's own `PI_CODING_AGENT_DIR` variable, so it works with plain Pi and with any program that runs Pi.

## Requirements

- Pi 1.4 or later.

## Install

```sh
pi install npm:@jals1212/pi-spaces
```

That adds `/space` and the `--space` option to Pi. A program that runs Pi with its own home installs it the same way, through its own install command.

The `pi-space` shell command is optional and is a separate package, so it is installed and updated on its own; `pi install` does not put commands on your `PATH`, so it comes from npm:

```sh
npm install -g @jals1212/pi-spaces-cli
```

## Quick start

```text
/space new work          create a space
/space                   pick a space; Pi restarts in it
/space switch base       back to the home Pi started with
```

From your shell:

```sh
pi --space work                         # start Pi in "work"
pi --space work "review this branch"    # with a prompt
pi-space new work                       # create a space (optional CLI)
pi-space remove work                    # delete it, after asking; keeps a backup unless told not to (optional CLI)
pi-space update --every                 # update the packages of base and of every space (optional CLI)
pi-space                                # pick from a numbered list (optional CLI)
```

A new space starts empty except for a `settings.json` that declares this package, so `/space` works inside it. Sign in and install packages there as you would in a fresh Pi.

## Commands in Pi

| Command | What it does |
| --- | --- |
| `/space` | Opens a list of the other spaces and restarts Pi in the one you pick. Without the interactive terminal it lists them instead. |
| `/space list` | Lists `base` and every space, with `*` on the active one. |
| `/space new <name>` | Creates an empty space. When a setup command is set (`PI_SPACES_SETUP`), it names `pi-space setup <name>` to run from a shell. |
| `/space switch <name>` | Restarts Pi in that space. `base` is the home Pi started with. |
| `/space switch` | Same as `/space`. |
| `/space rename <old> <new>` | Renames a space. The active space cannot be renamed. |
| `/space remove <name> [--yes] [--no-backup]` | Deletes a space after asking, then asks whether to keep a backup in `<spaces folder>/.backups` (keeping one is first in the list; dismissing the question keeps the space). `--yes` skips the questions and keeps a backup; it is required without a dialog (print and JSON modes). `--no-backup` deletes without one. |
| `pi --space <name>` | Starts Pi directly in a space, keeping the prompt and every other option. |
| `pi --space <name> <command> [args...]` | Runs one of Pi's package commands (`install`, `remove`, `uninstall`, `update`, `list`) in a space, or in the base home with `base`: `pi --space work update --extensions`, `pi --space work install npm:<package>`. |

The status line shows `◆ <name>` while a space is active. In the base home it shows `◆ base` when pi-spaces opened it (`pi --space base`, `pi-space base`, or `/space switch base`), and nothing when Pi was started plainly.

Choosing an argument such as `switch` from the `/space ` suggestions only fills the line; press Enter again to run it. `/space` and Enter opens the picker in one step.

**Names**: lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters. `base` is reserved, and so are the command words `list`, `new`, `remove`, `rename`, `switch`, `update`, `install`, `uninstall` and `setup`.

## The `pi-space` command

The optional `@jals1212/pi-spaces-cli` package adds a `pi-space` command to your shell: `pi-space` picks a space from a numbered list and starts Pi in it, `pi-space <name> [pi args...]` starts Pi in a named space, `pi-space new <name>` creates one, `pi-space rename <old> <new>` renames one, `pi-space remove <name>` deletes one, and `pi-space list` lists them. `pi-space list|update|install|uninstall <name|--every> ...` runs Pi's package commands in a space, or in every space. `--command` and `--dir` (or `PI_SPACES_COMMAND` and `PI_SPACES_DIR`) make it run another program that runs Pi, with that program's spaces, and `--setup` (or `PI_SPACES_SETUP`) gives that program's command to prepare a new space: `pi-space new` runs it, and `pi-space setup <name|--every>` runs it again. It only runs `pi --space <name> [command]`, so this extension must be installed in the home it opens. See [`cli/README.md`](cli/README.md) for the commands, the options and the exit status.

## Configuration reference

### Where spaces live

In a `spaces` folder next to the home Pi starts with: `~/.pi/agent` keeps its spaces in `~/.pi/spaces/<name>/`. A program that runs Pi with its own home gets its own folder too, for example `~/.tool/agent` → `~/.tool/spaces`. The folder stays the same while you switch between spaces. `PI_SPACES_DIR` replaces it.

### Environment variables

Read:

| Variable | Meaning |
| --- | --- |
| `PI_SPACES_DIR` | The spaces folder. A relative value is taken from your home folder. Default: `spaces` next to the base home. |
| `PI_SPACES_COMMAND` | For the `pi-space` command ([`cli/README.md`](cli/README.md)): the program to run, before `--space <name>`. Default: `pi`. |
| `PI_SPACES_SETUP` | For the `pi-space` command: the command that prepares a new space. `/space new` names `pi-space setup <name>` when it is set. |
| `PI_CODING_AGENT_DIR` | Pi's agent home; its parent holds the default spaces folder. Default: `~/.pi/agent`. |

Set for the Pi a switch starts:

| Variable | Meaning |
| --- | --- |
| `PI_CODING_AGENT_DIR` | The space's folder, or the base home for `base`. |
| `PI_SPACE` | The space's name. Unset in the base home. |
| `PI_SPACES_BASE_HOME` | The home Pi started with, so `base` and the spaces folder survive switches. |

Set in every Pi this extension runs in, even one started without a switch, for its tools and the programs they start:

| Variable | Meaning |
| --- | --- |
| `PI_SPACE` | The active space's name, unset in the base home: the same variable a switch sets. |
| `PI_SPACE_HOME` | The agent home this Pi runs with: the space's folder, or the base home. |
| `PI_SPACES_COMMAND` | Kept when it has a value; set to `pi` when it is unset or blank. |

### What the model is told

Before each run the system prompt gets a `<pi_space>` section with the same three facts: the space (or the base home), the agent home, and the command, with `<command> --space <name>` and `/space` as the ways to change space. The model knows where it runs without reading the environment. A Pi without structured prompt sections gets no section; the variables are still set.

### The `pi-spaces` skill

The package also ships a `pi-spaces` skill (`skills/pi-spaces/SKILL.md`). It tells agents what a space is, how to read the current space, home and command, and which `/space` or `pi-space` action to use or propose for listing, creating, switching and removing spaces. Pi loads it when a task is about spaces; `/skill:pi-spaces` loads it by hand.

### Exit status

| Status | `pi --space` |
| --- | --- |
| 0 … | Pi's own exit status. |
| 1 | An unknown or invalid space, or no name after `--space`. |

The `pi-space` command has its own: see [`cli/README.md`](cli/README.md#exit-status).

## How switching works

Pi reads its agent home once, when it starts, so a running session cannot move to another home. `/space switch` closes Pi and starts the same command again with the space's home:

- `PI_CODING_AGENT_DIR`, `PI_SPACE` and `PI_SPACES_BASE_HOME` are set as in [Environment variables](#environment-variables).
- Any other variable whose value is the old home, or a path inside it, moves to the same path in the new home; in a list such as `PATH`, each entry moves on its own. This keeps variables that a launcher derived from the home consistent. `PWD` and `OLDPWD` are left alone.
- The same options are kept, such as `--model`, `-e`, `--tools` and other extensions' options. The initial prompt, `@file` arguments, everything after `--`, and the session options (`-c`, `-r`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`, `-n`) are dropped, because they belong to the home being left.
- Switching works only in the interactive terminal.

`pi --space <name>` acts before Pi opens its interface or runs anything, so it keeps the prompt and the session options too, in every mode.

`pi --space <name> <command> ...`, where `<command>` is one of Pi's package commands right after the name, runs Pi again in that home with only `<command> ...`: Pi runs a package command only as its first argument. Options before `--space`, such as a launcher's own `-e`, are left out. The same Pi runs it, so a launcher's own Pi manages the space's packages; `base` and the current home work too.

## What it leaves on your machine

Only the spaces you create, each a folder in the spaces folder, and its `settings.json`. Pi fills a space as it would any home. Removing a space moves its folder to `.backups/<name>-<UTC time>` in the spaces folder, or deletes it with `--no-backup` or when you choose so; nothing else is written outside it. A backup is a whole space: move it back to restore it (`mv ~/.pi/spaces/.backups/work-2026-10-28T14-30-05Z ~/.pi/spaces/work`), or delete it when you no longer need it. Backups are never removed for you, and `.backups` is never listed as a space.

## Safety

`/space remove`, `/space rename`, `pi-space remove` and `pi-space rename` refuse, before they ask:

- `base` and the active space;
- symlinks, and anything that is not a real folder directly inside the spaces folder;
- a space that holds the current or base home;
- a spaces folder that is the filesystem root, your home folder, or the agent home (or inside it).

A backup also needs `.backups` to be a real folder, not a symlink or a file.

## Development

Two packages live in this repository: the Pi extension and its shared core at the root (`@jals1212/pi-spaces`), and the `pi-space` command in `cli/` (`@jals1212/pi-spaces-cli`).

```sh
npm test                         # links cli/ to this checkout, builds both, runs both test suites (Node 22.18 or later)
pi -e ./extensions/spaces.ts     # try the extension without installing it
```

`src/` is TypeScript. Pi loads the extension's TypeScript itself. The command in `cli/` imports the core as `@jals1212/pi-spaces/spaces`: the plain JavaScript in `dist/` that `npm run build` makes (Node does not strip types from files under `node_modules`). `npm pack` and `npm publish` build it first. `scripts/link-self.mjs` makes `cli/node_modules/@jals1212/pi-spaces` a link to this checkout, so the command's tests use the core from the working tree instead of from npm.

Branches: work goes to `develop` through pull requests; `main` receives `develop` when a release closes.

## Releasing

Each package has its own version, its own `CHANGELOG.md` and its own tag prefix:

| Package | Directory | Tag | Version and notes |
| --- | --- | --- | --- |
| `@jals1212/pi-spaces` (the extension) | `.` | `vX.Y.Z` | `package.json`, `CHANGELOG.md` |
| `@jals1212/pi-spaces-cli` (`pi-space`) | `cli/` | `cli-vX.Y.Z` | `cli/package.json`, `cli/CHANGELOG.md` |

1. On a `release/X.Y.Z` branch from `develop`: set `version` in the package's `package.json`, rename `## Unreleased` in its `CHANGELOG.md` to `## X.Y.Z`, and commit `release X.Y.Z: <summary>`. Merge it into `develop`, then `develop` into `main`.
2. Tag `main` and push the tag: `vX.Y.Z` for the extension, `cli-vX.Y.Z` for the command.
3. The [release workflow](.github/workflows/release.yml) checks the tag against that package's `package.json` and `CHANGELOG.md`, runs the tests of both packages, and stages the version on npm through trusted publishing, with provenance. Approve it with 2FA: `npm stage list`, then `npm stage approve <id>`, or on npmjs.com.
4. The workflow then creates the GitHub release, with the version's section of that package's `CHANGELOG.md` as notes.

The command takes its core from the extension package (the `@jals1212/pi-spaces` range in `cli/package.json`). A CLI release needs a version in that range already on npm, so release the extension first and approve it; the workflow refuses a `cli-v*` tag otherwise. When the command needs a newer core, raise the range in `cli/package.json` in the same release.

## License

MIT
