# 🪐 pi-space

The `pi-space` command: pick a [Pi](https://pi.dev) space and start Pi in it, create, set up, rename, migrate and remove spaces, and install, update and list the packages of a space, from your shell. Every space is named `<profile>/<name>`: a [profile](#profiles) of a config file says which program to run and where its spaces live, so one short command is enough for each program, and [shell completion](#shell-completion) completes the commands and the spaces of every profile. It works on its own or alongside the Pi extension [`pi-spaces`](https://github.com/jals1212/pi-spaces#readme), which adds `/space` and the status line inside Pi: see [With or without the Pi extension](#with-or-without-the-pi-extension).

## Install

```sh
npm install -g pi-spaces-cli
```

Node 20 or later, on macOS, Linux or Windows (see [Windows](#windows)).

### With or without the Pi extension

The command does not need the Pi extension [`pi-spaces`](https://github.com/jals1212/pi-spaces#two-packages-use-either-one-or-both); it depends only on its library code, and installs nothing into any Pi home. What it needs depends on how the profile starts a space:

| Profile | Starting a space and the package commands | Without the extension |
| --- | --- | --- |
| `commands.space` with `{home}` (`gentle-shell --home {home}`) | Runs the command directly in the space's home and sets the space's variables itself ([A command with `{home}`](#a-command-with-home)) | Works |
| The built-in `pi`, or `commands.space` without `{home}` | Runs `pi --space <name> [command]` (or the filled-in command); the extension does the switch | Needs the extension in the base home, **0.4.0 or later** for the package commands (an older one starts Pi in the space instead of running the command) |

`new`, `setup`, `rename`, `remove`, `migrate`, `list` (without a space), `init` and completion only work on folders and never need the extension. Without it, Pi itself has no `/space`, no status line and no `<pi_space>` prompt section; install it as well to get them. `new` asks whether the new space declares the extension (see [Creating a space without the extension](#creating-a-space-without-the-extension)).

### Windows

Everything works the same on Windows, and [shell completion](#powershell) works in PowerShell:

- **The config file** is the first that exists of `config.toml` and `config.json` in `%USERPROFILE%\.config\pi-spaces` (`C:\Users\<you>\.config\pi-spaces\config.toml`, or in `XDG_CONFIG_HOME` when you set it), then in `%USERPROFILE%\.pi-spaces`; else `%USERPROFILE%\.pi-spaces\config.toml`. `~` in it, and in `PI_SPACES_CONFIG`, is that same user folder, so `"home": "~/.my-launcher/agent"` means `C:\Users\<you>\.my-launcher\agent`. Set `PI_SPACES_CONFIG` for good with `setx PI_SPACES_CONFIG "D:\path\config.json"`, or for one PowerShell session with `$env:PI_SPACES_CONFIG = "..."`.
- **The commands** run as on macOS and Linux, and the CI runs the tests on Windows. A program installed by npm as a `.cmd` shim (such as `pi.cmd`) is found without its extension.
- **The picker** (`pi-space` alone) needs a terminal that supports raw mode and ANSI escape codes, as Windows Terminal and PowerShell 7 do. It has not been tested on a real Windows console: the CI has no terminal.
- **Shell completion** works in PowerShell 7 and Windows PowerShell 5.1 (see [PowerShell](#powershell)), and in zsh under WSL. cmd has no programmable completion: use the picker there.

## Naming a space

Every space the command takes is `<profile>/<name>`, `base` included: `pi/work`, `pi/base`, `my/work`. The profile is the first word, up to the first `/`; it names an entry of the [config file](#profiles), and `pi` is always there (plain Pi). The name is the space as `/space` knows it, and `<profile>/base` is the home that profile's Pi starts with.

A bare name is refused, with the forms to use, and nothing is started:

```text
$ pi-space work
pi-space: Name the space with its profile, as <profile>/work (profiles: pi, my).
```

The exit status is 2. There is no default profile: the file's `default` is not used (see [Profiles](#profiles)).

## Commands

The command words are reserved: a space can never be named `list`, `new`, `remove`, `rename`, `switch`, `update`, `install`, `uninstall`, `setup` or `completion`, so any other first word is a space (`<profile>/<name>`; the reservation of `completion` is in `pi-spaces` 0.6.0).

| Command | What it does |
| --- | --- |
| `pi-space` | Starts the space [pinned](#pinning-a-space-to-a-folder) to this folder, if there is one. Otherwise it opens a picker of the spaces of every profile (its hint line starts with 🪐) and starts Pi in the one you choose: ↑/↓ (or Ctrl-P/Ctrl-N, Tab) move, Enter starts Pi, Esc cancels, typing filters by `profile/name`. The profiles go in [their order](#the-order-of-the-profiles); each profile's `<profile>/base` comes first in its group (with more than one profile, a header names the group), and the cursor starts on the space this Pi runs in, marked `(active)`. The space starts with the profile it was listed under. Profiles that share a folder are all listed: each one means a different command. |
| `pi-space pick` | Opens the picker even where a space is pinned, with the cursor on the pinned space. |
| `pi-space pin <profile>/<name>` | Pins a space to the repository you are in (see [Pinning a space to a folder](#pinning-a-space-to-a-folder)). |
| `pi-space pin` | Prints the space pinned here and the file it comes from, or `No space pinned here.` |
| `pi-space unpin` | Removes the space pinned to the repository you are in. |
| `pi-space <profile>/<name> [pi args...]` | Starts Pi in that space, with that profile's command (`<profile>/base` runs `commands.base` as it is, with no `--space`); a space command with `{home}` is run in the space's home instead (see [A command with `{home}`](#a-command-with-home)). Pi takes each word as a separate message, so when no word is an option (none starts with `-`) the words become one message: `pi-space pi/work fix the tests` sends `fix the tests`, and `@file` words stay apart, before it. Pi's own commands are not joined: when the first word is `install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth` or `mcp`, the words go as they are (`pi-space pi/work install npm:x`). With any option the words go as they are, so quote a prompt there: `pi-space pi/work -c "fix the tests"`. |
| `pi-space list` | Lists the spaces of every profile, grouped by profile, in [their order](#the-order-of-the-profiles): each profile's folder, then its `base` and spaces as `profile/space`. |
| `pi-space list <profile>/<name>` | Lists the packages of a space (Pi's `list`). |
| `pi-space list <profile>/--every` or `--every` | The packages of a profile's base and spaces, or of every profile's (see below). |
| `pi-space new <profile>/<name> [--extension\|--no-extension]` | Creates an empty space in that profile's folder (a root folder with its agent home, `agent/`, inside), as `/space new <name>` does in Pi, asks whether it declares the extension (see [Creating a space without the extension](#creating-a-space-without-the-extension)), then runs the profile's setup command in it when there is one (see [Preparing a new space](#preparing-a-new-space)). It does not start Pi. |
| `pi-space setup <profile>/<name>` | Runs the setup command in a space, or in `<profile>/base`. |
| `pi-space setup <profile>/--every` or `--every` | Runs it in every space of the profile, or of every profile that has a setup command. |
| `pi-space migrate <profile>/<name>` | Gives an old space (no `agent/` folder: its folder is its agent home) the new layout: it copies the whole space to `<spaces folder>/.backups/<name>-<UTC time>`, then moves its content into `<space>/agent/`. It refuses `base` (exit 1), the space you are in, a space that already has `agent/`, and a space that holds the base home. See [Moving an old space](https://github.com/jals1212/pi-spaces#moving-an-old-space). |
| `pi-space migrate <profile>/--every` or `--every` | Migrates every space of the profile, or of every profile, never `base`. A space that already has `agent/` is skipped with a note; a failure does not stop the rest, and the exit status is 1 if any failed, with the last line on stderr naming them (`pi-space: migrate failed in: pi/a`). |
| `pi-space rename <profile>/<old> <new>` | Renames a space, as `/space rename` does in Pi. The new name is bare or keeps the profile (`pi/work client`, `pi/work pi/client`); a space never changes profile. It refuses what `remove` refuses (see below). |
| `pi-space remove <profile>/<name> [--yes] [--no-backup]` | Deletes a space, as `/space remove <name>` does in Pi. It asks first (`[y/N]`), then whether to keep a backup in `<spaces folder>/.backups` (`[Y/n]`: Enter keeps one). `--yes` skips the questions and keeps a backup, and is required without a terminal; `--no-backup` deletes without one. |
| `pi-space update <profile>/<name>` | Runs Pi's `update` in a space; `<profile>/--every` and `--every` run it in many (see below). What follows is Pi's: `--extensions`, `--all`, a source. With nothing after the space it is Pi's default. |
| `pi-space install <profile>/<name> <source> [pi install options...]` | Runs Pi's `install` in a space (or `<profile>/--every`, `--every`). The source is required. |
| `pi-space uninstall <profile>/<name> <source> [pi options...]` | Runs Pi's `uninstall` (its alias of `remove`) in a space (or `<profile>/--every`, `--every`). The source is required. |
| `pi-space init` | Writes the config file (schema v2) with no profiles of its own, and a header of comments that shows how the built-in `pi` profile is set up and a profile for another program (see [Profiles](#profiles)). It writes to `--config <path>` or the usual location (`~/.pi-spaces/config.toml` when there is no file yet), creating its folders; the file is TOML, or JSON when `--config` names a path that does not end in `.toml`. It never reads or overwrites a file: when it exists, it exits with status 1 and prints `pi-space: <file> already exists; edit it, or remove it to write a new one.` When the file cannot be written (a folder of its path cannot be made, no permission), it exits with status 1 and prints `pi-space: cannot write <file>: <reason>`. |
| `pi-space completion <shell>` | Prints the completion script of a shell: `zsh` or `powershell` (see [Shell completion](#shell-completion)). Any other shell, or none, exits with status 2. |
| `pi-space <command> --help` | Shows the help of one command: what it does, its arguments and options, the call options that apply, and examples (`pi-space --help <command>` and `-h` work too). |
| `pi-space --help` | Shows the usage. |
| `pi-space --version` | Prints the version. |

`--help` (or `-h`) anywhere after a command word shows that command's help and does nothing else: `pi-space remove pi/work --help` removes nothing, and it reads no config file. After a space every argument belongs to Pi, so `pi-space pi/work --help` starts Pi with `--help`. An unknown command (`pi-space --help ghost`) exits with status 2 and lists the commands.

`--new`, `--remove` (the options of 0.3) and `--profile` (0.6 and later) were replaced; they exit with status 2 and name what to use: `pi-space: --profile was replaced by: pi-space <profile>/<name>`. The profile is now the first word of the space instead of an option before the command.

### Pinning a space to a folder

Like `.nvmrc` for Node, a project can name the space `pi-space` starts in it:

```text
$ cd ~/work/erp
$ pi-space pin gentle/work
Pinned gentle/work in /Users/me/work/erp/.pi/pi-space/space.
$ pi-space
pi-space: gentle/work (from /Users/me/work/erp/.pi/pi-space/space)
```

- `pin` writes `.pi/pi-space/space` in the root of the git repository (the current folder outside one), after checking that the space exists. The file holds one line, `<profile>/<name>` (`base` included); blank lines and `#` comments are ignored. Pinning again replaces it and names the previous space.
- Next to it, `pin` writes `.pi/pi-space/.gitignore` with `*`, which ignores the whole `pi-space` folder, itself included, so nothing shows in `git status`. The rest of `.pi` (Pi's own project files) is never touched, and a `.gitignore` already there is kept as it is.
- A bare `pi-space` in that folder or any folder below starts the pinned space at once, as `pi-space <profile>/<name>` does, after a line on stderr that names the file. The marker is looked for from the current folder upwards, and the nearest wins. Your home folder is skipped (its `.pi` is Pi's own folder), and `pin` refuses it.
- A space named on the command line wins: `pi-space pi/other` starts `pi/other`. `pi-space pick` opens the picker, with the cursor on the pinned space.
- A marker that does not name one space as `<profile>/<name>` exits 2 and names the file; one that names a missing space or profile fails as `pi-space <profile>/<name>` would. Neither falls back to the picker.
- `pi-space pin` alone prints the space pinned here and its file. `pi-space unpin` removes the marker of the repository, the `.gitignore` that `pin` wrote, and the `pi-space` folder (and `.pi`) once empty; run from a folder below another marker, it names that one and leaves it.

Only `pi-space` reads the marker: Pi itself, `pi` and `/space` do not.

### Packages in a space, or in many

```sh
pi-space list pi/work                     # the packages of "work", in plain Pi
pi-space install my/work npm:some-package # install in "work" of the profile "my" only
pi-space update pi/base --extensions      # update the extensions of plain Pi's base home
pi-space update my/--every                # my's base, then every space of "my"
pi-space update --every                   # every profile: its base, then its spaces
```

A package command runs `pi --space <name> <command> [args...]` with Pi's stdio, through the profile's command (or `--command`), and ends with the exit status of that Pi. In `<profile>/base` it runs `pi <command> [args...]` with no `--space`, since base is the profile's own home: `--space` is the extension's option, so this lets `install --every npm:pi-spaces` install the extension in a base home that does not have it yet. The extension relaunches Pi in the space's home, so the command works on that home's `settings.json` and packages; the Pi starts with the profile's home as `PI_CODING_AGENT_DIR` (see "What the started Pi is told"). `<profile>/<name>` is `<profile>/base` or an existing space of that profile; anything else exits with status 1 before Pi starts.

`--every` takes the place of the space, and there are two:

- `<profile>/--every` runs in that profile's `base` first, then in every one of its spaces in order.
- `--every` alone runs in every profile, in [their order](#the-order-of-the-profiles), each in the order above.

The runs go one after the other, each after a `== <profile>/<name>` line on stdout. A failure does not stop the rest. The exit status is 0 if every run succeeded, otherwise 1, and the last line on stderr names the spaces that failed: `pi-space: update failed in: my/base, my/work`.

### A command with `{home}`

A v2 profile's `commands.base` starts the base home as it is, and its `commands.space` is the template of a space. When `space` contains `{home}`, it is the program itself, run in the agent home of the space, and the program's own commands work through the profile:

```toml
[profiles.launcher]
home = "~/.my-launcher/agent"
spaceEnv = { MY_LAUNCHER_CONFIG_HOME = "{home}/config" }

[profiles.launcher.commands]
base = "my-launcher"
space = "my-launcher --home {home}"
setup = "my-launcher --home {home} setup"
```

<details><summary>The same in JSON</summary>

```json
"launcher": {
  "home": "~/.my-launcher/agent",
  "commands": {
    "base": "my-launcher",
    "space": "my-launcher --home {home}",
    "setup": "my-launcher --home {home} setup"
  },
  "spaceEnv": { "MY_LAUNCHER_CONFIG_HOME": "{home}/config" }
}
```

</details>

```sh
pi-space launcher/base                    # my-launcher
pi-space launcher/base upgrade            # my-launcher upgrade
pi-space launcher/work                    # my-launcher --home ~/.my-launcher/spaces/work/agent
pi-space launcher/work --version          # my-launcher --home ~/.my-launcher/spaces/work/agent --version
pi-space launcher/work fix the tests      # my-launcher --home ~/.my-launcher/spaces/work/agent "fix the tests"
pi-space update launcher/base             # my-launcher update
pi-space update launcher/--every          # base: my-launcher update; each space: my-launcher --home <its home> update
```

Each command is split as for `--command`, and in every word `{home}` becomes the space's agent home (`<space>/agent`; the space's folder itself for an old space that has no `agent/`), `{space}` its root folder and `{name}` its name; in `base` they are the profile's `home`, the folder above it and `base`. The words after the space come after the command (joined into one message as above, and not joined when the first one is a command of Pi), and there is no `--space`. The package commands (`list`, `update`, `install`, `uninstall`) run `<command> <verb> [args...]` the same way, so they go through the program, which must pass them to Pi. The picker starts the space you choose the same way. `--command` with `{home}` does the same for one call, and replaces `commands`.

The three commands, in short:

- `base` is run as it is, with the words after `base` after it and no `--space`. This is why it is plain `my-launcher`: some programs behave differently when they are given their home explicitly (an option such as `--home`), even when it is their own default home, so the base home starts the program exactly as you would run it yourself.
- `space` with `{home}` is started in the space's home, with the environment of the space. `space` without `{home}` (`pi --space {name}`) is filled in and run with the plain environment, since the program switches itself. With no `space`, a space starts `<base> --space <name>`.
- `setup` prepares a new space (see [Preparing a new space](#preparing-a-new-space)).

The environment is the one Pi gets from `--space`, without Pi doing the switch: in `base`, the plain environment of the profile (`PI_CODING_AGENT_DIR` is its `home`, no variable of a space) plus `PI_SPACES_BASE_HOME` (the profile's `home`, so the status line shows `🪐 <profile>/base`); in a space with `{home}`, that plus `PI_CODING_AGENT_DIR`, `PI_SPACE_HOME` (the space's agent home), `PI_SPACE` (its name), `PI_SPACES_BASE_HOME` (the profile's `home`), the profile's `spaceEnv` for the space, and `PI_SPACES_BASE_ENV` (the base's own values of the `spaceEnv` variables, so `/space switch base` inside works; absent when the profile has no `spaceEnv`). The exit status is the program's. An unclosed quote in a command exits with status 2 before anything starts.

Things to know:

- The words go after the home option in a space, so a program's own command works there only when the program accepts it after the home option. In `base` there is no home option, so `pi-space launcher/base upgrade` is `my-launcher upgrade`.
- Keep the `spaceEnv` of the program's own config home (here `MY_LAUNCHER_CONFIG_HOME`): without it, a space's `--home` would leave the program's configuration shared with the base home.

#### The v1 `command` with `{home}` (legacy)

A v1 profile has `command` (and `setup`, `homeless`) instead of `commands`. A `command` with `{home}` (`my-launcher --home {home}`) is run in the home of every space, `base` included, with no `--space`, as `commands.space` is; without `{home}` it runs as `<command> --space <name> [words...]`. `homeless` words (`"homeless": ["upgrade", "self-uninstall", "memory"]`) run the command without every word that has `{home}` (and an option right before a bare `{home}`: `--home {home}` goes away whole), `{space}` and `{name}` still filled in, then the words as they are (never joined), with no `--space` and the plain environment of the profile: `pi-space launcher/base upgrade` runs `my-launcher upgrade`. `homeless` is only in v1; in v2 `base` does it. See [Moving from v1 to v2](https://github.com/jals1212/pi-spaces#moving-from-v1-to-v2).

### The order of the profiles

Wherever `pi-space` shows or runs more than one profile (`list` alone, the picker, `--every` alone, completion, and the profiles named in a message), `pi` comes first, then the other profiles in alphabetical order, whatever their order in the config file. Within a profile, `base` comes first, then its spaces in alphabetical order.

A new space gets an `agent/settings.json` that declares the extension, unless you answer no (below), so `/space` works inside it: the same declaration as in the base home's `settings.json` (the profile's `home`; for `pi` that is `PI_SPACES_BASE_HOME`, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`), or `npm:pi-spaces` when the base home does not declare it. A local path counts when it is a copy of the extension: a folder whose `package.json` is named `pi-spaces`.

### Creating a space without the extension

`agent/settings.json` only declares the extension: the command installs nothing. Pi installs every package a home declares and does not have yet the first time it runs there, so a declared extension appears in the space with the first `pi` run or `pi-space install` in it. In a terminal, `new` asks first:

```text
$ pi-space new gentle/work
Created space "work" at ~/.gentle-shell/spaces/work.
Declare the Pi extension pi-spaces in "work"? Pi installs it there and gets /space and the status line; pi-space does not need it. [Y/n] n
It does not declare the extension; add it later with: pi-space install gentle/work npm:pi-spaces
Start Pi in it with: pi-space gentle/work
```

Enter, `y` or the end of input declare it; only `n` or `no` leave `agent/settings.json` as `{}`. `--extension` and `--no-extension` answer without asking. Without a terminal (a script, a pipe) the command does not ask and declares it, as before. The setup command runs either way.

Leave it out when the profile's `commands.space` has `{home}` and you do not want `/space` in that space. With the built-in `pi` profile, starting the space needs the extension in the **base** home, not in the space; without it in the space, Pi there has no `/space` to switch away, so go back with `pi-space pi/base`.

`remove`, `rename` and `migrate` refuse `base`, the space you are in, a space that holds the base home, and anything that is not a real folder inside the spaces folder, before they ask. A backup is the whole space folder (the root, with `agent/` in it when it has one), moved to `.backups/<name>-<UTC time>`; move it back to restore it. See [what it leaves on your machine](https://github.com/jals1212/pi-spaces#what-it-leaves-on-your-machine).

## Another program that runs Pi

The usual way is a [profile](#profiles) that holds the program's `commands`, `dir` and `spaceEnv`: `pi-space my/work`. To start Pi through another program for one call without a profile, give `--command` and `--dir` before the rest, with the profile they override (`pi` is always there); `--command` has its v1 meaning for that call and replaces the profile's `commands`: its words come before `--space`, or it is the program itself when it has `{home}`. The words are split on spaces; double or single quotes keep a path with spaces in one word. Such a program usually has its own home, so `--dir` points at its spaces folder, and the Pi it starts gets that folder as `PI_SPACES_DIR` too. Nothing is exported, so a plain `pi` in the same shell is not affected. Every command accepts these options and uses the ones it needs (`list <space>` ignores `--setup`, `rename` ignores `--command` and `--setup`), so one alias can give them all:

```sh
pi-space --command "my-launcher --" --dir ~/.my-launcher/spaces pi/work   # → my-launcher -- --space work
pi-space --dir ~/.my-launcher/spaces new pi/work                          # create one in that folder
pi-space --command '"/opt/my launcher/run" --' pi/work                    # a path with spaces, in quotes
```

Inside quotes a backslash is a plain character, so `"C:\Program Files\my-launcher\run.cmd"` works as written. A quote that is never closed is an error (exit status 2), and nothing is started.

`--command`, `--dir` and `--setup` override the profile you name, for that one call: they belong to one profile. So they cannot go with something that spans profiles (the picker, `list` alone, or a global `--every`); that exits with status 2 and nothing runs:

```text
pi-space: --command and --dir apply to one profile; name it: <profile>/<name> or <profile>/--every.
```

`--setup` is the exception: it applies to each profile a global `--every` or `setup --every` runs in. It replaces `commands.setup`.

A call has no other settings. `pi-space` does **not** read `PI_SPACES_COMMAND`, `PI_SPACES_DIR` or `PI_SPACES_SETUP` from your shell: the command, the spaces folder and the setup command come from the profile, or from the call options above. A shell that still exports them is harmless to `pi-space` but changes nothing in it. They are what `pi-space` hands to the Pi it starts, and what the extension reads there:

| Variable | Meaning |
| --- | --- |
| `PI_SPACES_COMMAND` | For the started Pi, the profile's command (a v2 profile's `commands.space`, else `commands.base`; or `--command`); unset when there is none, so a caller's value never leaks. The extension reads it to tell the model and the tools how Pi was started. |
| `PI_SPACES_DIR` | For the started Pi, the profile's spaces folder (or `--dir`), always. The extension reads it as its spaces folder. |
| `PI_SPACES_SETUP` | For the started Pi, the profile's setup command (`commands.setup`, or `--setup`); unset when there is none. `/space new` there names `pi-space setup <profile>/<name>` when it is set. |
| `PI_SPACES_CONFIG` | The [config file](#profiles) with the profiles. A leading `~` is your home folder and a relative value is taken from it. Default: the first that exists of `config.toml` and `config.json` in `~/.config/pi-spaces` (or `$XDG_CONFIG_HOME/pi-spaces`), then in `~/.pi-spaces`; else `~/.pi-spaces/config.toml`. `--config` wins for one call; a relative `--config` is taken from the current folder. This one `pi-space` still reads. |
| `PI_CODING_AGENT_DIR` | Pi's agent home; the built-in `pi` profile's `home` (its parent holds the default spaces folder). Default: `~/.pi/agent`. |

## Profiles

Profiles are named in an optional config file, in TOML or JSON: each says which program to run (a command for the base, one for a space, one for setup), its home, where its spaces live and how to set one up, so you do not have to repeat `--command`, `--dir` and `--setup`, or write shell variables and functions, for each program that runs Pi. The profile is the first word of every space you name. This section is the command's side of it; the file format (every key, the schema versions, `spaceEnv`, comments, what happens when the file is wrong) is in the [main README](https://github.com/jals1212/pi-spaces#profiles). `pi-space init` writes a starter file, and a file in the older v1 format keeps working (see [Moving from v1 to v2](https://github.com/jals1212/pi-spaces#moving-from-v1-to-v2)).

```sh
pi-space list                           # every profile with its base and spaces
pi-space ml/work                        # start the profile's program in its space "work"
pi-space new ml/work                    # create it, then run the profile's setup in it
pi-space init                           # write a starter config file (refuses an existing one)
pi-space --config ./other.json ml/work  # the same profile from another file, for this call
```

`--config <path>` comes before the command, like `--command`, `--dir` and `--setup`: each needs a value (not blank) and may be given once, and after a space they belong to Pi. An unknown profile exits with status 2 and lists the known ones: `pi-space: Unknown profile "ghost"; known profiles: ml, pi.`

- **The file** is `--config`, else `PI_SPACES_CONFIG`, else the first that exists of `~/.config/pi-spaces/config.toml`, `~/.config/pi-spaces/config.json` (`$XDG_CONFIG_HOME/pi-spaces/...` when `XDG_CONFIG_HOME` is an absolute path), `~/.pi-spaces/config.toml` and `~/.pi-spaces/config.json`; else `~/.pi-spaces/config.toml`. The first found wins and nothing is moved. A path ending in `.toml` is read as TOML, any other as JSON (with `//` and `/* */` comments). When `config.toml` and `config.json` are in the same folder, `config.toml` is read and each call says so on stderr, then goes on:

  ```text
  pi-space: ~/.pi-spaces/config.json is ignored: ~/.pi-spaces/config.toml is read instead; remove one of them.
  ```

  `--config` and `PI_SPACES_CONFIG` are read as given, with no such warning. A missing file is not an error: with no file the only profile is `pi`. A file that is wrong exits with status 2 and prints its message (`pi-space: <file>: <problem>`), never a stack. `--help`, `--version` and `completion` never read it.
- **`default`** is ignored. The file is still valid with it (the schema accepts it, and `spaceEnv` and the rest work), but `pi-space` names every space with its profile and never falls back to one. Each call that reads such a file says so on stderr, then goes on:

  ```text
  pi-space: ~/.pi-spaces/config.toml: "default" is no longer used; name each space with its profile (<profile>/<name>) and remove "default" from the file.
  ```

  Remove the key to silence it.
- **`pi`** is built in: base `pi`, spaces `pi --space {name}`, home `PI_CODING_AGENT_DIR` (else `~/.pi/agent`), unless another profile of the file names that home: then `~/.pi/agent`, so `pi/` means plain Pi even from inside another program's Pi. It always exists, so `pi/work` is plain Pi from the same shell, and a `pi` in the file's `profiles` replaces it. `--profile`, which used to pick a profile, is gone: the profile is the first word of the space.

### Which value wins

For each of the command, the spaces folder and the setup command, the first of these that has a value is used:

1. the call option (`--command`, `--dir`, `--setup`), which overrides the profile you named (`--command` replaces `commands`, `--setup` replaces `commands.setup`);
2. that profile's own `commands`, `dir` or `commands.setup` (`command`, `dir` or `setup` in a v1 file);
3. the built-in: `pi`, the `spaces` folder next to the profile's `home`, no setup command.

`PI_SPACES_COMMAND`, `PI_SPACES_DIR` and `PI_SPACES_SETUP` are not on the list: `pi-space` does not read them (see above). A profile never borrows from another. A profile's spaces folder is its `dir`, which is `spaces` next to its `home` when it leaves `dir` out. A profile's `home` is also the base home a new space's `settings.json` takes the extension's declaration from, and `remove` and `rename` refuse the space that holds it.

### What the started Pi is told

The Pi that `pi-space` starts (a space, or a package command) reads the same file and the same folders, so `pi-space` hands over what it settled, as environment variables for that child only:

- `PI_SPACES_DIR` is always the profile's spaces folder (or `--dir`), absolute.
- `PI_SPACES_COMMAND` and `PI_SPACES_SETUP` are the profile's command (a v2 profile's `commands.space`, else `commands.base`) and setup (`commands.setup`), or `--command` and `--setup`; a profile without one leaves the variable unset, even if your shell has it.
- `--config <path>` becomes `PI_SPACES_CONFIG` (absolute).
- `PI_CODING_AGENT_DIR` is the profile's `home`, so the started Pi runs as if you had started it from a plain terminal for that profile, even when you run `pi-space` from the shell of another Pi (a Pi started by another program, say): `pi-space pi/base` starts plain Pi in `~/.pi/agent`, not in the home of the Pi you are in.
- Run from inside a space, `pi-space` first unwinds that space: the caller profile's `spaceEnv` variables get back their base values (from `PI_SPACES_BASE_ENV`, or are removed when it has none), every variable that is the space's agent home or a path inside it (each entry of a list on its own) moves to the base home, and `PI_SPACE`, `PI_SPACE_HOME`, `PI_SPACES_BASE_HOME` and `PI_SPACES_BASE_ENV` are removed. The extension then enters the named space from a clean base. `remove` and `rename` still refuse the space you are in.
- Nothing else is added or removed. `--command` and the rest are never read back from them.

### `spaceEnv` and the setup command

A space always belongs to a profile, so that profile's `spaceEnv` is added to the environment of the setup command (`commands.setup`), with `{home}`, `{space}` and `{name}` filled in for the space being set up, next to `PI_CODING_AGENT_DIR`, `PI_SPACE` and `PI_SPACE_HOME`; the rest of its environment is the same unwound base as for Pi, so the space you run `pi-space` from never leaks into it. It applies whichever setup command runs: the profile's own setup, or one from `--setup`, because the space is that profile's.

### A complete example

A program called `my-launcher` keeps its agent home in `~/.my-launcher/agent` and its own configuration outside it. `~/.pi-spaces/config.toml`:

```toml
schema = "pi-spaces.config/v2"

[profiles.my]
home = "~/.my-launcher/agent"
spaceEnv = { MY_LAUNCHER_CONFIG_HOME = "{home}/config" }

[profiles.my.commands]
base = "my-launcher --"
setup = "my-launcher --home {home} setup"
```

<details><summary>The same in JSON (<code>~/.pi-spaces/config.json</code>)</summary>

```json
{
  "schema": "pi-spaces.config/v2",
  "profiles": {
    "my": {
      "home": "~/.my-launcher/agent",
      "commands": {
        "base": "my-launcher --",
        "setup": "my-launcher --home {home} setup"
      },
      "spaceEnv": { "MY_LAUNCHER_CONFIG_HOME": "{home}/config" }
    }
  }
}
```

</details>

Then, without a variable, an alias or a function:

```sh
pi-space new my/work       # creates ~/.my-launcher/spaces/work (with agent/ inside), then runs:
                           #   my-launcher --home ~/.my-launcher/spaces/work/agent setup
                           # with MY_LAUNCHER_CONFIG_HOME=~/.my-launcher/spaces/work/agent/config
pi-space my/work -c        # my-launcher -- --space work -c
pi-space my/base           # my-launcher --
pi-space setup my/--every  # run the setup again in every space of "my"
pi-space list              # my and pi, each with its base and spaces
pi-space pi/work           # a space of plain Pi, from the same shell
```

### Shortening it (optional)

The command needs no help, but a shell alias or abbreviation can shorten a space you open often to one word. It is only sugar: no logic lives in it, and the profile stays in the config file.

```sh
alias myw='pi-space my/work'           # any POSIX shell: `myw -c` is `pi-space my/work -c`
abbr myw="pi-space my/work"            # zsh-abbr: typing `myw` expands to the command
```

## Shell completion

`pi-space` completes its commands (each with a one-line summary), the spaces of every profile as `<profile>/<name>`, `--every` and `<profile>/--every`, and files after `--config` and `--dir`. It works in zsh and in PowerShell. For zsh, add to `~/.zshrc` (after `compinit`):

```sh
source <(pi-space completion zsh)
```

For PowerShell, see [PowerShell](#powershell) below.

It asks the command itself for the candidates each time, through the hidden `pi-space __complete`, so it always sees your current config and spaces. `pi-space <TAB>` gives the same spaces as the picker, with each profile's `base` included. Options already typed are honored: `--config` makes it read that file, and `--dir` makes it list the spaces of that folder under each profile's prefix. It lists:

| After | Candidates |
| --- | --- |
| `pi-space` (and the call options) | `<profile>/base` and the spaces of every profile (pi's first, then the custom profiles', each in alphabetical order), then the commands (`completion` is not offered, but works typed in full) |
| `--config`, `--dir` | files (the shell's own completion) |
| `remove`, `rename` | the spaces of every profile (never `base`) |
| `setup` | the spaces, `--every` ("every profile") and `<profile>/--every` |
| `list`, `update`, `install`, `uninstall` | `<profile>/base`, the spaces, `--every` and `<profile>/--every` |
| `completion` | `zsh`, `powershell` |

There is no `--profile` to complete: the profile is the first word of the space. In first place the call options not typed yet come too, and `--help` and `--version` when nothing comes before. After a command word the options come too: `--help` for every command, `--yes` and `--no-backup` after `remove`, and `--extension` and `--no-extension` after `new`. zsh and PowerShell show them once the word starts with `-`, so `pi-space new <TAB>` never fills in a lone `--help`.

Completion also works through an abbreviation or alias: they expand first, so what the alias stands for is what completes. A config file that is wrong just gives no candidates; completion never prints an error.

### What you see

The candidates come in groups, each with a description: spaces, commands, targets (`--every`), shells and options. A space says what it is and which program opens it: `launcher/base -- base home of launcher (my-launcher --)`, `launcher/work -- space of launcher (my-launcher --)`.

The order is fixed: the spaces first, pi's before the custom profiles', each in alphabetical order; then the commands, in alphabetical order; then the options. The script sets `zstyle ':completion:*:pi-space:*' sort false`, so neither zsh nor fzf-tab sorts them again into one list.

### Plain zsh or fzf-tab

The script also sets, for pi-space alone, `group-name ''` and the descriptions format `[%d]`, so every group has a header. How the header shows depends on what draws the list:

| Menu | The headers | Example |
| --- | --- | --- |
| Plain zsh | Separators: each header sits above its group | `[spaces]`, the spaces, `[commands]`, the commands |
| [fzf-tab](https://github.com/Aloxaf/fzf-tab) | A legend: one line above the list names the groups, each in the color its candidates have | `[spaces]  [commands]` on top, spaces in one color, commands in another |

fzf-tab shows a single flat list, so it has no separator line between groups; `zstyle ':fzf-tab:*' switch-group '<' '>'` lets you jump from one group to the next. To get zsh's own menu, with the headers as separators, for pi-space alone and fzf-tab everywhere else, add to `~/.zshrc`:

```sh
zstyle ':fzf-tab:complete:pi-space:*' disabled-on any   # fzf-tab off for pi-space
zstyle ':completion:*:pi-space:*' menu select           # move with the arrows, Enter picks
```

You lose fuzzy search there: type the start of a name and press Tab again to narrow it.

### After an update

The candidates come from `pi-space` at each Tab, so a new version's order and descriptions show at once. A change to the script itself (its styles, say) shows in a new shell: `source <(pi-space completion zsh)` reads the script when the shell starts. If you keep the script in a file instead, write it again after each update (`pi-space completion zsh > <file>`), or regenerate it when the `pi-space` binary is newer than the file.

### PowerShell

Works in PowerShell 7 and in Windows PowerShell 5.1. Add to your profile (`notepad $PROFILE`):

```powershell
pi-space completion powershell | Out-String | Invoke-Expression
```

To pick from a menu when you press Tab, add this line too:

```powershell
Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete
```

What you see:

- One list, in pi-space's order: the spaces, the commands, then the options.
- The description of a candidate is its tooltip (in the menu, at the bottom).
- No group headers: PowerShell has none.
- Files after `--config` and `--dir`: PowerShell's own path completion.
- Nothing to offer (after a finished name, or a word that matches no candidate): Tab does nothing, instead of PowerShell's usual fallback to the folder's files.

The options show once the word starts with `-`. cmd has no programmable completion, so there is nothing to load there.

### Other shells

The zsh and PowerShell scripts are built in. The hidden `pi-space __complete <words before the cursor>` prints one `<group>\t<value>\t<description>` line per candidate, in the order to show, or the single line `__files__` when the shell should complete a file. A completer for another shell (bash, fish) can be written on top of it.

## Preparing a new space

A new space starts clean: only an `agent/settings.json` that declares the extension. A program that runs Pi may need its own packages in every home it opens. Give it as the profile's `setup`, or with `--setup` for one call, and `pi-space new` runs it right after it creates the space. The words are split as for `--command`, and in each word `{home}` becomes the space's agent home (`<space>/agent`), `{space}` its root folder and `{name}` its name. The command runs with your stdio, and with `PI_CODING_AGENT_DIR` and `PI_SPACE_HOME` set to the space's agent home and `PI_SPACE` to its name:

```sh
pi-space --setup 'my-launcher --home {home} setup' new pi/work     # create "work", then: my-launcher --home ~/.pi/spaces/work/agent setup
pi-space --setup 'pi install npm:some-package' new pi/work         # plain Pi: install a package in the new space
pi-space --setup 'my-launcher --home {home} setup' setup pi/--every # run it again in every space of "pi", for example after an update
```

When the setup fails, the space is kept and `pi-space` exits with the setup's status, naming `pi-space setup <profile>/<name>` to run it again. `pi-space setup <profile>/<name>` ends with the setup's status. `pi-space setup <profile>/base` runs it in the profile's home: `{home}` is that home, `{space}` the folder above it and `{name}` `base`, with the plain environment of the profile (its `PI_CODING_AGENT_DIR` is that home, no `PI_SPACE` and no `spaceEnv`). With `<profile>/--every` it runs in `base`, then in every space of that profile in order; with `--every` alone, in the `base` and spaces of every profile that has a setup command (a profile without one, such as the built-in `pi`, is skipped; none at all exits with status 2). Each run comes after a `== <profile>/<name>` line, and the exit is as the package commands'. A profile without a setup command (and no `--setup`) exits with status 2: `pi-space: Profile "pi" has no setup command; give it a "setup" in the config file, or give --setup <cmd>.`

Only those three variables change. A variable that points into the base home stays as it is, so a setup that needs one per space sets it itself, for example `env MY_CONFIG={home}/config my-launcher --home {home} setup`. The setup reaches the Pi that `pi-space` starts as `PI_SPACES_SETUP`, so `/space new` there names `pi-space setup <profile>/<name>`.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 … | Pi's own exit status, for a space and for a package command in one space; the setup's exit status for `setup <profile>/<name>` and for a `new` whose setup failed. |
| 1 | An unknown or invalid space (or one missing from its profile), a name `new` or `rename` cannot use (taken, reserved or invalid), a space `remove`, `rename` or `migrate` cannot touch (`migrate` also refuses `base` and a space that already has `agent/`), `remove` without `--yes` and no terminal, the program could not start, or `--every` and at least one run failed (the failed spaces are on the last line of stderr) or `init` when the file already exists or cannot be written. |
| 130 | Ctrl-C in the picker. |
| 2 | A config file that is wrong or an unknown profile (the problem is printed), a space named without its profile (the forms to use are printed), a `rename` to another profile, `completion` with another shell or none, no arguments and no terminal to pick in, a command with the wrong number of names (`new`, `remove`, `rename`), `install` or `uninstall` without a source, a package command without a space or `--every`, `--command` or `--dir` with the picker, `list` alone or a global `--every` (they apply to one profile), or `--command`, `--dir`, `--setup` or `--config` without a value (or a blank one) or given twice: the usage is printed. `setup` without a setup command (`Profile "pi" has no setup command`) or with no profile having one: the problem is printed. The old `--new`, `--remove` and `--profile`: the replacing command is printed. A `--command`, `--setup` or a profile's `command` or `setup` with an unclosed quote: the problem is printed, and nothing is created or started. |

## More

Spaces, the `/space` commands in Pi, how switching works and safety: see the [main README](https://github.com/jals1212/pi-spaces#readme).

## License

MIT
