# pi-space

The `pi-space` command: pick a [Pi](https://pi.dev) space and start Pi in it, create, set up, rename and remove spaces, and install, update and list the packages of a space, from your shell. It is the optional companion of the Pi extension [`@jals1212/pi-spaces`](https://github.com/jals1212/pi-spaces#readme), which holds the spaces themselves.

## Install

```sh
npm install -g @jals1212/pi-spaces-cli
```

Node 20 or later. The Pi extension `@jals1212/pi-spaces` must be installed in the home the command opens: `pi-space` only runs `pi --space <name> [command]`, and the extension does the switch. For the package commands (`list <name>`, `update`, `install`, `uninstall`) the extension in the base home must be **0.4.0 or later**: an older one starts Pi in the space instead of running the command.

## Commands

The command words are reserved: a space can never be named `list`, `new`, `remove`, `rename`, `switch`, `update`, `install`, `uninstall` or `setup`, so any other first word is a space name.

| Command | What it does |
| --- | --- |
| `pi-space` | Shows a numbered list of spaces and starts Pi in the one you pick. |
| `pi-space <name> [pi args...]` | Starts Pi in that space (`base` for the home Pi starts with). |
| `pi-space list` | Lists the spaces. |
| `pi-space list <name\|--every>` | Lists the packages of a space (Pi's `list`). |
| `pi-space new <name>` | Creates an empty space, as `/space new <name>` does in Pi, then runs the setup command in it when there is one (see [Preparing a new space](#preparing-a-new-space)). It does not start Pi. |
| `pi-space setup <name\|--every>` | Runs the setup command in a space, or in every space. Never in `base`. |
| `pi-space rename <old> <new>` | Renames a space, as `/space rename` does in Pi. It refuses what `remove` refuses (see below). |
| `pi-space remove <name> [--yes] [--no-backup]` | Deletes a space, as `/space remove <name>` does in Pi. It asks first (`[y/N]`), then whether to keep a backup in `<spaces folder>/.backups` (`[Y/n]`: Enter keeps one). `--yes` skips the questions and keeps a backup, and is required without a terminal; `--no-backup` deletes without one. |
| `pi-space update <name\|--every> [pi update options...]` | Runs Pi's `update` in a space. What follows is Pi's: `--extensions`, `--all`, a source. With nothing after the name it is Pi's default. |
| `pi-space install <name\|--every> <source> [pi install options...]` | Runs Pi's `install` in a space. The source is required. |
| `pi-space uninstall <name\|--every> <source> [pi options...]` | Runs Pi's `uninstall` (its alias of `remove`) in a space. The source is required. |
| `pi-space --help` | Shows the usage. |
| `pi-space --version` | Prints the version. |

`--new` and `--remove`, the options of 0.3, were replaced by `new` and `remove`; they exit with status 2 and name the command to use.

### Packages in a space, or in every space

```sh
pi-space list work                      # the packages of "work"
pi-space install work npm:some-package  # install in "work" only
pi-space update base --extensions       # update the extensions of the base home
pi-space update --every                 # base, then every space
```

A package command runs `pi --space <name> <command> [args...]` with Pi's stdio, through `$PI_SPACES_COMMAND` (or `--command`), and ends with the exit status of that Pi. The extension relaunches Pi in the space's home, so the command works on that home's `settings.json` and packages; `pi-space` never sets `PI_CODING_AGENT_DIR` itself. `<name>` is `base` or an existing space; anything else exits with status 1 before Pi starts.

`--every` takes the place of the name. The command runs in `base` first, then in every space in order, one after the other, each after a `== <name>` line on stdout. A failure does not stop the rest. The exit status is 0 if every run succeeded, otherwise 1, and the last line on stderr names the spaces that failed: `pi-space: update failed in: base, work`.

A new space gets a `settings.json` that declares the extension, so `/space` works inside it: the same declaration as in the base home's `settings.json` (`PI_SPACES_BASE_HOME`, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`), or `npm:@jals1212/pi-spaces` when the base home does not declare it. A local path counts when it is a copy of the extension: a folder whose `package.json` is named `@jals1212/pi-spaces`.

`remove` and `rename` refuse `base`, the space you are in, a space that holds the base home, and anything that is not a real folder inside the spaces folder, before it asks. A backup is the whole space folder, moved to `.backups/<name>-<UTC time>`; move it back to restore it. See [what it leaves on your machine](https://github.com/jals1212/pi-spaces#what-it-leaves-on-your-machine).

## Another program that runs Pi

To start Pi through another program for one call, give `--command` and `--dir` before the rest; the words of `--command` come before `--space`. The words are split on spaces; double or single quotes keep a path with spaces in one word. Such a program usually has its own home, so `--dir` points at its spaces folder, and the Pi it starts gets that folder as `PI_SPACES_DIR` too. Nothing is exported, so a plain `pi` in the same shell is not affected. Every command accepts these options and uses the ones it needs (`list` ignores `--command`, `rename` ignores `--setup`), so one alias can give them all:

```sh
pi-space --command "my-launcher --" --dir ~/.my-launcher/spaces work   # → my-launcher -- --space work
pi-space --dir ~/.my-launcher/spaces new work                           # create one in that folder
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
| `PI_SPACES_SETUP` | The command that prepares a new space (see [Preparing a new space](#preparing-a-new-space)). Unset or blank: none. `--setup` wins for one call. |
| `PI_CODING_AGENT_DIR` | Pi's agent home; its parent holds the default spaces folder. Default: `~/.pi/agent`. |

## Preparing a new space

A new space starts clean: only a `settings.json` that declares the extension. A program that runs Pi may need its own packages in every home it opens. Give its setup command with `--setup` (or `PI_SPACES_SETUP`), and `pi-space new` runs it right after it creates the space. The words are split as for `--command`, and in each word `{home}` becomes the space's folder and `{name}` its name. The command runs with your stdio, and with `PI_CODING_AGENT_DIR` and `PI_SPACE_HOME` set to the space's folder and `PI_SPACE` to its name:

```sh
pi-space --setup 'my-launcher --home {home} setup' new work     # create "work", then: my-launcher --home ~/.pi/spaces/work setup
pi-space --setup 'pi install npm:some-package' new work         # plain Pi: install a package in the new space
pi-space --setup 'my-launcher --home {home} setup' setup --every # run it again in every space, for example after an update
```

When the setup fails, the space is kept and `pi-space` exits with the setup's status, naming `pi-space setup <name>` to run it again. `pi-space setup <name>` ends with the setup's status. With `--every` it runs in every space in order, never in `base`, each after a `== <name>` line, and exits as the package commands do. `base` is the home the program prepares itself.

Only those three variables change. A variable that points into the base home stays as it is, so a setup that needs one per space sets it itself, for example `env MY_CONFIG={home}/config my-launcher --home {home} setup`. `--setup` also reaches the Pi that `pi-space` starts as `PI_SPACES_SETUP`, so `/space new` there names `pi-space setup <name>`.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 … | Pi's own exit status, for a space and for a package command in one space; the setup's exit status for `setup <name>` and for a `new` whose setup failed. |
| 1 | An unknown or invalid space, a name `new` or `rename` cannot use (taken, reserved or invalid), a space `remove` or `rename` cannot touch, `remove` without `--yes` and no terminal, an out-of-range pick, the program could not start, or `--every` and at least one run failed (the failed spaces are on the last line of stderr), or `setup base`, since setup runs only in spaces. |
| 2 | No arguments and no terminal to pick in, a command with the wrong number of names (`new`, `remove`, `rename`), `install` or `uninstall` without a source, a package command without a space or `--every`, or `--command`, `--dir` or `--setup` without a value or given twice: the usage is printed. `setup` without a setup command: the problem is printed. The old `--new` and `--remove`: the replacing command is printed. A `--command`, `PI_SPACES_COMMAND`, `--setup` or `PI_SPACES_SETUP` with an unclosed quote: the problem is printed, and nothing is created or started. |

## More

Spaces, the `/space` commands in Pi, how switching works and safety: see the [main README](https://github.com/jals1212/pi-spaces#readme).

## License

MIT
