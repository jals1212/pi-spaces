# pi-space

The `pi-space` command: pick a [Pi](https://pi.dev) space and start Pi in it, create, set up, rename and remove spaces, and install, update and list the packages of a space, from your shell. Named [profiles](#profiles) in a config file say which program to run and where its spaces live, so one short command is enough for each program, and [shell completion](#shell-completion) completes the commands, the profiles and the spaces. It is the optional companion of the Pi extension [`@jals1212/pi-spaces`](https://github.com/jals1212/pi-spaces#readme), which holds the spaces themselves.

## Install

```sh
npm install -g @jals1212/pi-spaces-cli
```

Node 20 or later. The Pi extension `@jals1212/pi-spaces` must be installed in the home the command opens: `pi-space` only runs `pi --space <name> [command]`, and the extension does the switch. For the package commands (`list <name>`, `update`, `install`, `uninstall`) the extension in the base home must be **0.4.0 or later**: an older one starts Pi in the space instead of running the command.

## Commands

The command words are reserved: a space can never be named `list`, `new`, `remove`, `rename`, `switch`, `update`, `install`, `uninstall`, `setup` or `completion`, so any other first word is a space name (the reservation of `completion` is in `@jals1212/pi-spaces` 0.6.0).

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
| `pi-space completion zsh` | Prints the zsh completion script (see [Shell completion](#shell-completion)). Any other shell, or none, exits with status 2. |
| `pi-space <command> --help` | Shows the help of one command: what it does, its arguments and options, the call options that apply, and examples (`pi-space --help <command>` and `-h` work too). |
| `pi-space --help` | Shows the usage. |
| `pi-space --version` | Prints the version. |

`--help` (or `-h`) anywhere after a command word shows that command's help and does nothing else: `pi-space remove work --help` removes nothing, and it reads no config file. After a space name every argument belongs to Pi, so `pi-space work --help` starts Pi with `--help`. An unknown command (`pi-space --help ghost`) exits with status 2 and lists the commands.

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

To start Pi through another program for one call, give `--command` and `--dir` before the rest (or name a [profile](#profiles) that holds both); the words of `--command` come before `--space`. The words are split on spaces; double or single quotes keep a path with spaces in one word. Such a program usually has its own home, so `--dir` points at its spaces folder, and the Pi it starts gets that folder as `PI_SPACES_DIR` too. Nothing is exported, so a plain `pi` in the same shell is not affected. Every command accepts these options and uses the ones it needs (`list` ignores `--command`, `rename` ignores `--setup`), so one alias can give them all:

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
| `PI_SPACES_CONFIG` | The [config file](#profiles) with the profiles. A leading `~` is your home folder and a relative value is taken from it. Default: `~/.pi-spaces/config.json`. `--config` wins for one call; a relative `--config` is taken from the current folder. |
| `PI_CODING_AGENT_DIR` | Pi's agent home; its parent holds the default spaces folder. Default: `~/.pi/agent`. |

## Profiles

Profiles are named in an optional JSON config file, so you do not have to repeat `--command`, `--dir` and `--setup`, or write shell variables and functions, for each program that runs Pi. This section is the command's side of it; the file format (every key, the schema version, `spaceEnv`, what happens when the file is wrong) is in the [main README](https://github.com/jals1212/pi-spaces#profiles).

```sh
pi-space --profile ml list          # the spaces of the profile "ml"
pi-space --profile ml work          # start the profile's program in its space "work"
pi-space --profile ml new work      # create it, then run the profile's setup in it
pi-space --config ./other.json --profile ml list   # the same profile from another file, for this call
```

`--profile <name>` and `--config <path>` come before the command, like `--command`, `--dir` and `--setup`: each needs a value (not blank) and may be given once, and after a space name they belong to Pi. An unknown profile exits with status 2 and lists the known ones: `pi-space: Unknown profile "ghost"; known profiles: ml, pi.`

- **The file** is `--config`, else `PI_SPACES_CONFIG`, else `~/.pi-spaces/config.json`. A missing file is not an error: with no file the command behaves exactly as without profiles. A file that is wrong exits with status 2 and prints its message (`pi-space: <file>: <problem>`), never a stack. `--help`, `--version` and `completion` never read it.
- **`default`**: without `--profile`, the file's `default` profile is used, if it names one. With `--profile`, the default is not consulted at all: a profile never borrows from another.
- **`pi`** is built in: command `pi`, home `PI_CODING_AGENT_DIR` (else `~/.pi/agent`). It always exists, so `--profile pi` goes back to plain Pi when the default is another program, and a `pi` in the file's `profiles` replaces it.

### Which value wins

For each of the command, the spaces folder and the setup command, the first of these that has a value is used:

1. the call option (`--command`, `--dir`, `--setup`);
2. the profile named with `--profile`;
3. the variable (`PI_SPACES_COMMAND`, `PI_SPACES_DIR`, `PI_SPACES_SETUP`);
4. the file's `default` profile;
5. the built-in: `pi`, the `spaces` folder next to the base home, no setup command.

A profile's spaces folder is its `dir`, which is `spaces` next to its `home` when it leaves `dir` out. A profile's `home` is also the base home a new space's `settings.json` takes the extension's declaration from (instead of `PI_SPACES_BASE_HOME` or `PI_CODING_AGENT_DIR`), and `remove` and `rename` refuse the space that holds it.

### What the started Pi is told

The Pi that `pi-space` starts (a space, or a package command) reads the same file and the same folders, so `pi-space` hands over what it settled, as environment variables for that child only:

- `--config <path>` becomes `PI_SPACES_CONFIG` (absolute), like `--dir` becomes `PI_SPACES_DIR`.
- When a profile supplies a `dir` or a `setup`, they reach it as `PI_SPACES_DIR` and `PI_SPACES_SETUP`, exactly as `--dir` and `--setup` would, so `/space new` there agrees with `pi-space new`.
- Nothing else is added: when nothing is to be passed, the child inherits your environment as it is. `--command` is never passed.

### `spaceEnv` and the setup command

When a profile is selected (`--profile`, or the default), its `spaceEnv` is added to the environment of the setup command, with `{home}` and `{name}` filled in for the space being set up, next to `PI_CODING_AGENT_DIR`, `PI_SPACE` and `PI_SPACE_HOME`. It applies whichever setup command runs: the profile's own `setup`, or one from `--setup` or `PI_SPACES_SETUP`, because the space is that profile's. A call without any profile adds nothing, as before.

### A complete example

A program called `my-launcher` keeps its agent home in `~/.my-launcher/agent` and its own configuration outside it. `~/.pi-spaces/config.json`:

```json
{
  "schema": "pi-spaces.config/v1",
  "profiles": {
    "my": {
      "home": "~/.my-launcher/agent",
      "command": "my-launcher --",
      "setup": "my-launcher --home {home} setup",
      "spaceEnv": { "MY_LAUNCHER_CONFIG_HOME": "{home}/config" }
    }
  }
}
```

Then, without a variable, an alias or a function:

```sh
pi-space --profile my new work     # creates ~/.my-launcher/spaces/work, then runs:
                                   #   my-launcher --home ~/.my-launcher/spaces/work setup
                                   # with MY_LAUNCHER_CONFIG_HOME=~/.my-launcher/spaces/work/config
pi-space --profile my work -c      # my-launcher -- --space work -c
pi-space --profile my setup --every   # run the setup again in every space of "my"
pi-space --profile pi list         # the spaces of plain Pi, from the same shell
```

Add `"default": "my"` to the file and `pi-space work` alone does the second line; `pi-space --profile pi work` is then plain Pi.

### Shortening it (optional)

The command needs no help, but a shell abbreviation or alias can shorten `--profile my` to one word. It is only sugar: no logic lives in it, and the profile stays in the config file.

```sh
abbr my-space="pi-space --profile my"      # zsh-abbr; typing `my-space work` expands to `pi-space --profile my work`
alias my-space='pi-space --profile my'     # any POSIX shell
```

## Shell completion

`pi-space` completes its commands (each with a one-line summary), the profile names after `--profile`, files after `--config` and `--dir`, and the spaces. For zsh, add to `~/.zshrc` (after `compinit`):

```sh
source <(pi-space completion zsh)
```

It asks the command itself for the candidates each time, through the hidden `pi-space __complete`, so it always sees your current config and spaces. Options already typed are honored: after `pi-space --profile my remove <TAB>` you get the spaces of `my`, not those of the default. It lists:

| After | Candidates |
| --- | --- |
| `pi-space` (and the call options) | the commands, then `base` and the spaces (`completion` is not offered, but works typed in full) |
| `--profile` | the profile names, `pi` included, each with its command |
| `--config`, `--dir` | files (the shell's own completion) |
| `remove`, `rename` | the spaces |
| `setup` | the spaces and `--every` |
| `list`, `update`, `install`, `uninstall` | `base`, the spaces and `--every` |
| `completion` | `zsh` |

In first place the call options not typed yet come too, and `--help` and `--version` when nothing comes before. After a command word the options come too: `--help` for every command, and `--yes` and `--no-backup` after `remove`. zsh shows them once the word starts with `-`, so `pi-space new <TAB>` never fills in a lone `--help`.

The candidates come in groups, each with a description, and zsh lists each group apart: commands, spaces (`base` is "the home Pi starts with"), profiles, shells and options. The hidden `pi-space __complete` prints one `<group>\t<value>\t<description>` line per candidate (or the single line `__files__` when the shell should complete a file), so a script for another shell can use it.

Completion also works through an abbreviation or alias like the one above: they expand first, so `my-space <TAB>` completes what `pi-space --profile my <TAB>` would. A config file that is wrong, or a profile that does not exist, just gives no candidates; completion never prints an error.

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
| 2 | A config file that is wrong or an unknown `--profile` (the problem is printed), `completion` with another shell or none, no arguments and no terminal to pick in, a command with the wrong number of names (`new`, `remove`, `rename`), `install` or `uninstall` without a source, a package command without a space or `--every`, or `--command`, `--dir`, `--setup`, `--profile` or `--config` without a value (or a blank one) or given twice: the usage is printed. `setup` without a setup command: the problem is printed. The old `--new` and `--remove`: the replacing command is printed. A `--command`, `PI_SPACES_COMMAND`, `--setup`, `PI_SPACES_SETUP` or a profile's `command` or `setup` with an unclosed quote: the problem is printed, and nothing is created or started. |

## More

Spaces, the `/space` commands in Pi, how switching works and safety: see the [main README](https://github.com/jals1212/pi-spaces#readme).

## License

MIT
