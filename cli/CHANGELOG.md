# Changelog

Each release of `@jals1212/pi-spaces-cli`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
commands and options and a patch version fixes.

## Unreleased

## 0.6.1

### Added

- `pi-space <command> --help` (also `-h`, and `pi-space --help <command>`)
  prints the help of one command: what it does, its arguments and options, the
  call options that apply to it, and examples. `--help` anywhere after the
  command word counts, so `pi-space remove work --help` prints the help and
  removes nothing. After a space name it still belongs to Pi:
  `pi-space work --help` starts Pi with `--help`. An unknown command exits with
  status 2. It reads no config file and starts nothing.

### Changed

- Completion groups its candidates (commands, spaces, profiles, options) and
  describes them: each command shows a one-line summary, `base` and the spaces
  are told apart, a profile shows its command, and `remove` offers `--yes` and
  `--no-backup`. `--help` is offered, as the options are, once the word starts
  with `-`. The hidden `__complete` prints `<group>\t<value>\t<description>`
  lines instead of bare words.
- Completion no longer offers `completion` among the commands; it still works
  typed in full, and `pi-space completion <TAB>` still offers `zsh`.

## 0.6.0

### Added

- Profiles: `--profile <name>` and `--config <path>`, before the command, use a
  named profile of the config file (`~/.pi-spaces/config.json`, or
  `PI_SPACES_CONFIG`, or `--config`) for the command, the spaces folder and the
  setup command, and the file's `default` profile is used without `--profile`.
  Each setting is taken from the call option, then the `--profile` profile,
  then `PI_SPACES_COMMAND`, `PI_SPACES_DIR` or `PI_SPACES_SETUP`, then the
  default profile, then the built-in. The built-in profile `pi` always exists.
  With no file, nothing changes.
- A profile's `spaceEnv` is added, filled in for the space, to the environment
  of the setup command (`new` and `setup`), whichever setup command runs.
- A profile's `home` is the base home a new space's declaration of the extension
  is taken from, and `remove` and `rename` refuse the space that holds it.
- The started Pi gets `--config` as `PI_SPACES_CONFIG`, and a profile's `dir`
  and `setup` as `PI_SPACES_DIR` and `PI_SPACES_SETUP`, as `--dir` and `--setup`
  do.
- `pi-space completion zsh` prints a zsh completion script (`source
  <(pi-space completion zsh)`): commands, profile names after `--profile`,
  files after `--config` and `--dir`, and the spaces of the profile, config or
  folder already typed. It calls the hidden `pi-space __complete`, which never
  prints an error.
- A config file that is wrong, or an unknown profile, exits with status 2 and
  prints the problem.

### Changed

- `completion` is a command word, so it can no longer name a space.
- Needs `@jals1212/pi-spaces` 0.6.0, which reads the config file
  (`@jals1212/pi-spaces/config`) and reserves the name `completion`.

## 0.5.0

### Added

- A setup command for new spaces: `--setup <cmd>` or `PI_SPACES_SETUP`. `pi-space
  new` runs it in the new space, and `pi-space setup <name|--every>` runs it
  again (never in `base`). `{home}` and `{name}` become the space's folder and
  name, and it runs with `PI_CODING_AGENT_DIR`, `PI_SPACE_HOME` and `PI_SPACE`
  set to the space, so a program that runs Pi can install what it needs there,
  for example `pi-space --setup 'my-launcher --home {home} setup' new work`. A
  failed setup keeps the space and names the command to run it again.
- `--setup` reaches the started Pi as `PI_SPACES_SETUP`.

### Fixed

- A blank `--command` or `--dir` (only spaces) is a usage error, as an empty one
  already was, instead of being taken as given.

### Changed

- Needs `@jals1212/pi-spaces` 0.5.0, which reserves the name `setup`.

## 0.4.0

### Added

- `pi-space list <name|--every>` lists the packages of a space, and
  `pi-space update`, `install` and `uninstall` take a space and run Pi's
  command of that name in it, for example `pi-space update work --extensions`
  or `pi-space install work npm:some-package`. What follows is Pi's own:
  `install` and `uninstall` need a source, and `update` may have none. The
  command runs through the extension (`pi --space <name> <command> ...`) and
  its exit status is `pi-space`'s. Needs `@jals1212/pi-spaces` 0.4.0 or later
  in the base home.
- `--every` takes the place of the space: the command runs in `base`, then in
  every space in turn, each after a `== <name>` line. A failure does not stop
  the rest; the exit status is 1 if any failed, and the last line on stderr
  names them: `pi-space: update failed in: base, work`.
- `pi-space rename <old> <new>` renames a space, as `/space rename` does, with
  the same refusals as `remove`.

### Changed

- `pi-space new <name>` and `pi-space remove <name> [--yes] [--no-backup]` are
  commands, like `list`, `rename` and Pi's own. They do what `--new` and
  `--remove` did, with the same questions and backup.
- The command words `list`, `new`, `remove`, `rename`, `switch`, `update`,
  `install` and `uninstall` can no longer name a space, so `pi-space <name>`
  never reads as a command (see the extension's 0.4.0).
- Requires `@jals1212/pi-spaces` 0.4.0 or later.

### Removed

- The options `--new` and `--remove`. They exit with status 2 and name the
  command that replaced them: `pi-space --new work` →
  `pi-space new <name>`, `pi-space --remove work` →
  `pi-space remove <name> [--yes] [--no-backup]`.

## 0.3.1

### Fixed

- On Windows the program is started through `cross-spawn`. npm shims such as
  `pi.cmd`, paths with spaces, a trailing backslash, `%` and other `cmd.exe`
  characters in the command or in Pi's arguments are passed as written.
- The picker reports a bad command (an unclosed quote) before it lists the
  spaces, not after you have chosen one.

### Changed

- Depends on `cross-spawn`.

## 0.3.0

### Added

- `pi-space --new <name>` creates a space from the shell, with the same
  `settings.json` as `/space new <name>`: the base home's declaration of
  `@jals1212/pi-spaces`, or `npm:@jals1212/pi-spaces`. It does not start Pi.
  A local path in the base home is copied when it is a copy of the extension.
- `pi-space --remove <name>` deletes a space after asking in
  the terminal, with the same safety checks as `/space remove`, then asks
  whether to keep a backup in `.backups` (`[Y/n]`: Enter keeps one). `--yes`
  skips the questions and keeps a backup, and is required without a terminal;
  `--no-backup` deletes without one.
- `--command <cmd>` and `--dir <path>`, before the rest of the arguments, set
  the program to run and the spaces folder for one call, instead of
  `PI_SPACES_COMMAND` and `PI_SPACES_DIR`. With `--dir`, the Pi it starts gets
  that folder as `PI_SPACES_DIR`.
- Quotes in `--command` and `PI_SPACES_COMMAND`: double or single quotes keep a
  path with spaces in one word, as in `--command '"/opt/my launcher/run" --'`.
  A quote that is never closed is an error (exit status 2) and starts nothing.

### Changed

- `pi-space list` with no spaces suggests `pi-space --new <name>`.
- A `"` or `'` in `PI_SPACES_COMMAND` is now a quote, no longer part of a
  word: a path with an apostrophe, such as `/home/o'neil/bin/run`, needs double
  quotes around it.
- Needs `@jals1212/pi-spaces` 0.2.0 or later (for `backupSpace` and the
  local-path rule of `--new`).

### Fixed

- `pi-space --new` copies the base home's local path to this checkout of the
  extension instead of writing `npm:@jals1212/pi-spaces`.
- `pi-space --remove` explains a backup that cannot be written (for example a
  read-only spaces folder): the space was not removed, and `--no-backup`
  removes it without one.
- A program whose path has spaces now starts, including on Windows, where
  cmd.exe runs it and each word is now quoted for it.

## 0.2.0

### Added

- `pi-space --version` (or `-v`) prints the version.

### Fixed

- An unknown option such as `--bogus` in first place is reported as an unknown
  option with the usage, exit code 2, instead of as an invalid space name.

## 0.1.0

### Added

- The `pi-space` command, split out of `@jals1212/pi-spaces` so the Pi extension
  and the command are installed and updated on their own.
- `pi-space` with no arguments shows a numbered picker of the spaces and starts
  Pi in the one you pick.
- `pi-space <name> [pi args...]` starts Pi in a space (`base` for the home Pi
  starts with), keeping the arguments after the name.
- `pi-space list` lists the spaces; `pi-space --help` shows the usage.
- `PI_SPACES_COMMAND` chooses the program to run, in place of `pi`.
- Exit status: Pi's own, 1 for an unknown or invalid space, an out-of-range pick
  or a program that could not start, and 2 when there is no terminal to pick in.
