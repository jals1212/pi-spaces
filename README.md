# pi-spaces

Named spaces for [Pi](https://pi.dev): keep several agent homes side by side and switch between them from inside Pi.

A space is a complete Pi agent home: its own sign-ins, packages, settings, skills and sessions. Use one per client, per experiment, or to try a package without touching your everyday setup.

## Install

```bash
pi install npm:@jals1212/pi-spaces
```

It works with any program that runs Pi, because it relies only on Pi's own `PI_CODING_AGENT_DIR` variable.

## Use

| Command | What it does |
|---|---|
| `/space` | Opens a list of the other spaces and restarts Pi in the one you pick. Without the interactive terminal it lists them instead. |
| `/space list` | Lists `base` and every space, with `*` on the active one. |
| `/space new <name>` | Creates an empty space. |
| `/space switch <name>` | Restarts Pi in that space. `/space switch base` goes back to the home Pi started with. |
| `/space switch` | Same as `/space`: opens the list to pick the space. |
| `/space rename <old> <new>` | Renames a space. The active space cannot be renamed. |
| `/space remove <name>` | Deletes a space after asking. Add `--yes` to skip the question; it is required when there is no dialog (print and JSON modes). |
| `pi --space <name>` | Starts Pi directly in a space, keeping the prompt and every other option. |

The status line shows `space: <name>` while a space is active, and nothing in the base home.

Choosing an argument such as `switch` from the `/space ` suggestions only fills the line; press Enter again to run it. Typing `/space` and pressing Enter opens the picker in one step.

```text
/space new work
/space switch work      # Pi restarts with the "work" home
/space switch base      # back to the home you started with
```

```bash
pi --space work "review this branch"   # start in "work" with a prompt
```

## Optional CLI

The package also ships a `pi-space` command for starting Pi in a space from your shell. `pi install` does not put commands on your `PATH`, so install it with npm if you want it:

```bash
npm i -g @jals1212/pi-spaces            # until it is published: npm i -g github:jals1212/pi-spaces
```

| Command | What it does |
|---|---|
| `pi-space` | Shows a numbered list of spaces and starts Pi in the one you pick. |
| `pi-space <name> [pi args...]` | Starts Pi in that space (`base` for the home Pi starts with). |
| `pi-space list` | Lists the spaces. A space named `list` can still be opened from the picker. |

`pi-space` runs `pi --space <name>`, so the extension must be installed in the home the command opens. To start Pi through another program that runs it, set `PI_SPACES_COMMAND` once in your shell profile; its words come before `--space`. Such a program usually has its own home, so point `PI_SPACES_DIR` at its spaces folder too, so `pi-space` lists and validates the same spaces:

```bash
export PI_SPACES_COMMAND="my-launcher --"        # pi-space work → my-launcher -- --space work
export PI_SPACES_DIR=~/.my-launcher/spaces       # the spaces next to that program's home
```

The CLI needs Node 22.18 or newer.

### Names

Lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters. `base` is reserved.

### Where spaces live

Spaces live in a `spaces` folder next to the home Pi starts with: `~/.pi/agent` keeps its spaces in `~/.pi/spaces/<name>/`. A program that runs Pi with its own home (through `PI_CODING_AGENT_DIR`) therefore gets its own spaces folder too, for example `~/.tool/agent` → `~/.tool/spaces`. The folder stays the same while you switch between spaces.

Set `PI_SPACES_DIR` to use one folder for everything; a relative value is taken from your home folder.

A new space starts empty except for a `settings.json` that declares this package, so `/space` is available inside it. Sign in and install packages there as you would in a fresh Pi.

## How switching works

Pi reads its agent home once, when it starts, so a running session cannot move to another home. `/space switch` closes Pi and starts the same command again with the space's home:

- `PI_CODING_AGENT_DIR` points at the space, `PI_SPACE` holds its name, and `PI_SPACES_BASE_HOME` remembers the home Pi started with.
- Any other environment variable whose value is the old home, or a path inside it, is moved to the same path in the new home; in a list such as `PATH`, each entry moves on its own. This keeps variables that a launcher derived from the home consistent. `PWD` and `OLDPWD` are left alone.
- The same options are kept, such as `--model`, `-e` and `--tools`. The initial prompt, `@file` arguments, everything after `--` and the session options (`-c`, `-r`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`, `-n`) are dropped, because they belong to the home being left.
- Switching is available only in the interactive terminal.
- `pi --space <name>` acts before Pi opens its interface or runs anything, so it keeps the prompt and the session options too. It works in every mode.

## Safety

`/space remove` and `/space rename` refuse:

- `base` and the active space;
- symlinks, and anything that is not a real folder directly inside the spaces folder;
- a space that holds the current or base home;
- a spaces folder that is the filesystem root, your home folder, or the agent home (or inside it).

## Development

```bash
npm test                         # node --test, Node 22.18 or newer
pi -e ./extensions/spaces.ts     # try the extension without installing it
```

## License

MIT
