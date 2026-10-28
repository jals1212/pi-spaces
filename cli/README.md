# pi-space

The `pi-space` command: pick a [Pi](https://pi.dev) space and start Pi in it, from your shell. It is the optional companion of the Pi extension [`@jals1212/pi-spaces`](https://github.com/jals1212/pi-spaces#readme), which holds the spaces themselves.

## Install

```sh
npm install -g @jals1212/pi-spaces-cli
```

Node 20 or later. The Pi extension `@jals1212/pi-spaces` must be installed in the home the command opens: `pi-space` only runs `pi --space <name>`, and the extension does the switch.

## Commands

| Command | What it does |
| --- | --- |
| `pi-space` | Shows a numbered list of spaces and starts Pi in the one you pick. |
| `pi-space <name> [pi args...]` | Starts Pi in that space (`base` for the home Pi starts with). |
| `pi-space list` | Lists the spaces. A space named `list` can still be opened from the picker. |
| `pi-space --new <name>` | Creates an empty space, as `/space new <name>` does in Pi. It does not start Pi. |
| `pi-space --remove <name> [--yes] [--no-backup]` | Deletes a space, as `/space remove <name>` does in Pi. It asks first (`[y/N]`), then whether to keep a backup in `<spaces folder>/.backups` (`[Y/n]`: Enter keeps one). `--yes` skips the questions and keeps a backup, and is required without a terminal; `--no-backup` deletes without one. |
| `pi-space --help` | Shows the usage. |
| `pi-space --version` | Prints the version. |

A new space gets a `settings.json` that declares the extension, so `/space` works inside it: the same declaration as in the base home's `settings.json` (`PI_SPACES_BASE_HOME`, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`), or `npm:@jals1212/pi-spaces` when the base home does not declare it. A local path counts when it is a copy of the extension: a folder whose `package.json` is named `@jals1212/pi-spaces`.

`--remove` refuses `base`, the space you are in, a space that holds the base home, and anything that is not a real folder inside the spaces folder, before it asks. A backup is the whole space folder, moved to `.backups/<name>-<UTC time>`; move it back to restore it. See [what it leaves on your machine](https://github.com/jals1212/pi-spaces#what-it-leaves-on-your-machine).

## Another program that runs Pi

To start Pi through another program for one call, give `--command` and `--dir` before the rest; the words of `--command` come before `--space`. The words are split on spaces; double or single quotes keep a path with spaces in one word. Such a program usually has its own home, so `--dir` points at its spaces folder, and the Pi it starts gets that folder as `PI_SPACES_DIR` too. Nothing is exported, so a plain `pi` in the same shell is not affected:

```sh
pi-space --command "my-launcher --" --dir ~/.my-launcher/spaces work   # → my-launcher -- --space work
pi-space --dir ~/.my-launcher/spaces --new work                         # create one in that folder
pi-space --command '"/opt/my launcher/run" --' work                     # a path with spaces, in quotes
```

Inside quotes a backslash is a plain character, so `"C:\Program Files\my-launcher\run.cmd"` works as written. A quote that is never closed is an error (exit status 2), and nothing is started.

An alias keeps it short: `alias my-space='pi-space --command "my-launcher --" --dir ~/.my-launcher/spaces'`. To make it the default instead, set the variables in your shell profile:

```sh
export PI_SPACES_COMMAND="my-launcher --"    # pi-space work → my-launcher -- --space work
export PI_SPACES_DIR=~/.my-launcher/spaces   # the spaces next to that program's home
```

| Variable | Meaning |
| --- | --- |
| `PI_SPACES_COMMAND` | The program to run, split on spaces (double or single quotes keep a path with spaces in one word, as in `"/opt/my launcher/run" --`), before `--space <name>`. Default: `pi`. `--command` wins for one call. |
| `PI_SPACES_DIR` | The spaces folder. A relative value is taken from your home folder. Default: `spaces` next to the base home. `--dir` wins for one call; a relative `--dir` is taken from the current folder. |
| `PI_CODING_AGENT_DIR` | Pi's agent home; its parent holds the default spaces folder. Default: `~/.pi/agent`. |

## Exit status

| Status | Meaning |
| --- | --- |
| 0 … | Pi's own exit status. |
| 1 | An unknown or invalid space, a name `--new` cannot use (taken, `base` or invalid), a space `--remove` cannot delete, `--remove` without `--yes` and no terminal, an out-of-range pick, or the program could not start. |
| 2 | No arguments and no terminal to pick in, `--new` or `--remove` without exactly one name, or `--command` or `--dir` without a value or given twice: the usage is printed. A `--command` or `PI_SPACES_COMMAND` with an unclosed quote: the problem is printed. |

## More

Spaces, the `/space` commands in Pi, how switching works and safety: see the [main README](https://github.com/jals1212/pi-spaces#readme).

## License

MIT
