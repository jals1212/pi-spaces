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
- For the optional `pi-space` command: Node 20 or later.

## Install

```sh
pi install npm:@jals1212/pi-spaces
```

That adds `/space` and the `--space` option to Pi. A program that runs Pi with its own home installs it the same way, through its own install command.

The `pi-space` shell command is optional; `pi install` does not put commands on your `PATH`, so it comes from npm:

```sh
npm install -g @jals1212/pi-spaces
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
pi-space                                # pick from a numbered list (optional CLI)
```

A new space starts empty except for a `settings.json` that declares this package, so `/space` works inside it. Sign in and install packages there as you would in a fresh Pi.

## Commands in Pi

| Command | What it does |
| --- | --- |
| `/space` | Opens a list of the other spaces and restarts Pi in the one you pick. Without the interactive terminal it lists them instead. |
| `/space list` | Lists `base` and every space, with `*` on the active one. |
| `/space new <name>` | Creates an empty space. |
| `/space switch <name>` | Restarts Pi in that space. `base` is the home Pi started with. |
| `/space switch` | Same as `/space`. |
| `/space rename <old> <new>` | Renames a space. The active space cannot be renamed. |
| `/space remove <name>` | Deletes a space after asking. `--yes` skips the question; it is required without a dialog (print and JSON modes). |
| `pi --space <name>` | Starts Pi directly in a space, keeping the prompt and every other option. |

The status line shows `space: <name>` while a space is active, and nothing in the base home.

Choosing an argument such as `switch` from the `/space ` suggestions only fills the line; press Enter again to run it. `/space` and Enter opens the picker in one step.

**Names**: lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters. `base` is reserved.

## The `pi-space` command

| Command | What it does |
| --- | --- |
| `pi-space` | Shows a numbered list of spaces and starts Pi in the one you pick. |
| `pi-space <name> [pi args...]` | Starts Pi in that space (`base` for the home Pi starts with). |
| `pi-space list` | Lists the spaces. A space named `list` can still be opened from the picker. |
| `pi-space --help` | Shows the usage. |

`pi-space` runs `pi --space <name>`, so the extension must be installed in the home the command opens. To start Pi through another program that runs it, set `PI_SPACES_COMMAND` in your shell profile; its words come before `--space`. Such a program usually has its own home, so point `PI_SPACES_DIR` at its spaces folder too, so `pi-space` lists the same spaces:

```sh
export PI_SPACES_COMMAND="my-launcher --"    # pi-space work → my-launcher -- --space work
export PI_SPACES_DIR=~/.my-launcher/spaces   # the spaces next to that program's home
```

## Configuration reference

### Where spaces live

In a `spaces` folder next to the home Pi starts with: `~/.pi/agent` keeps its spaces in `~/.pi/spaces/<name>/`. A program that runs Pi with its own home gets its own folder too, for example `~/.tool/agent` → `~/.tool/spaces`. The folder stays the same while you switch between spaces. `PI_SPACES_DIR` replaces it.

### Environment variables

Read:

| Variable | Meaning |
| --- | --- |
| `PI_SPACES_DIR` | The spaces folder. A relative value is taken from your home folder. Default: `spaces` next to the base home. |
| `PI_SPACES_COMMAND` | For `pi-space`: the program to run, split on spaces, before `--space <name>`. Default: `pi`. |
| `PI_CODING_AGENT_DIR` | Pi's agent home; its parent holds the default spaces folder. Default: `~/.pi/agent`. |

Set for the Pi a switch starts:

| Variable | Meaning |
| --- | --- |
| `PI_CODING_AGENT_DIR` | The space's folder, or the base home for `base`. |
| `PI_SPACE` | The space's name. Unset in the base home. |
| `PI_SPACES_BASE_HOME` | The home Pi started with, so `base` and the spaces folder survive switches. |

### Exit status

| Status | `pi-space` | `pi --space` |
| --- | --- | --- |
| 0 … | Pi's own exit status. | Pi's own exit status. |
| 1 | An unknown or invalid space, an out-of-range pick, or the program could not start. | An unknown or invalid space, or no name after `--space`. |
| 2 | No arguments and no terminal to pick in: the usage is printed. | |

## How switching works

Pi reads its agent home once, when it starts, so a running session cannot move to another home. `/space switch` closes Pi and starts the same command again with the space's home:

- `PI_CODING_AGENT_DIR`, `PI_SPACE` and `PI_SPACES_BASE_HOME` are set as in [Environment variables](#environment-variables).
- Any other variable whose value is the old home, or a path inside it, moves to the same path in the new home; in a list such as `PATH`, each entry moves on its own. This keeps variables that a launcher derived from the home consistent. `PWD` and `OLDPWD` are left alone.
- The same options are kept, such as `--model`, `-e`, `--tools` and other extensions' options. The initial prompt, `@file` arguments, everything after `--`, and the session options (`-c`, `-r`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`, `-n`) are dropped, because they belong to the home being left.
- Switching works only in the interactive terminal.

`pi --space <name>` acts before Pi opens its interface or runs anything, so it keeps the prompt and the session options too, in every mode.

## What it leaves on your machine

Only the spaces you create, each a folder in the spaces folder, and its `settings.json`. Pi fills a space as it would any home. Removing a space deletes its folder; nothing else is written outside it.

## Safety

`/space remove` and `/space rename` refuse:

- `base` and the active space;
- symlinks, and anything that is not a real folder directly inside the spaces folder;
- a space that holds the current or base home;
- a spaces folder that is the filesystem root, your home folder, or the agent home (or inside it).

## Development

```sh
npm test                         # builds dist/, then node --test (Node 22.18 or later)
pi -e ./extensions/spaces.ts     # try the extension without installing it
```

`src/` is TypeScript. Pi loads the extension's TypeScript itself; the `pi-space` command runs `dist/`, plain JavaScript that `npm run build` makes (Node does not strip types from files under `node_modules`). `npm pack` and `npm publish` build it first.

Branches: work goes to `develop` through pull requests; `main` receives `develop` when a release closes.

## Releasing

1. On a `release/X.Y.Z` branch from `develop`: set `version` in `package.json`, rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z`, and commit `release X.Y.Z: <summary>`. Merge it into `develop`, then `develop` into `main`.
2. Tag `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The [release workflow](.github/workflows/release.yml) checks the tag against `package.json` and `CHANGELOG.md`, runs the tests, and stages the version on npm through trusted publishing, with provenance. Approve it with 2FA: `npm stage list`, then `npm stage approve <id>`, or on npmjs.com.
4. The workflow then creates the GitHub release, with the version's `CHANGELOG.md` section as notes.

## License

MIT
