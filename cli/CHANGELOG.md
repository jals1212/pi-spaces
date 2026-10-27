# Changelog

Each release of `@jals1212/pi-spaces-cli`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
commands and options and a patch version fixes.

## Unreleased

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
