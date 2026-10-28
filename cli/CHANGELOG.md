# Changelog

Each release of `@jals1212/pi-spaces-cli`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
commands and options and a patch version fixes.

## Unreleased

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
