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
| `/space` or `/space list` | Lists `base` and every space, with `*` on the active one. |
| `/space new <name>` | Creates an empty space. |
| `/space switch <name>` | Restarts Pi in that space. `/space switch base` goes back to the home Pi started with. |
| `/space switch` | Opens a list to pick the space. |
| `/space rename <old> <new>` | Renames a space. The active space cannot be renamed. |
| `/space remove <name>` | Deletes a space after asking. Add `--yes` to skip the question; it is required when there is no dialog (print and JSON modes). |
| `pi --space <name>` | Starts Pi directly in a space, keeping the prompt and every other option. |

The status line shows `space: <name>` while a space is active, and nothing in the base home.

```text
/space new work
/space switch work      # Pi restarts with the "work" home
/space switch base      # back to the home you started with
```

```bash
pi --space work "review this branch"   # start in "work" with a prompt
```

### Names

Lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters. `base` is reserved.

### Where spaces live

Every space is a folder in `~/.pi/spaces/<name>/`. Set `PI_SPACES_DIR` to use another folder; a relative value is taken from your home folder.

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
