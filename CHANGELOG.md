# Changelog

Each release of `@jals1212/pi-spaces`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
commands and options and a patch version fixes.

## Unreleased

## 0.1.0

### Added

- Named spaces: separate Pi agent homes in a `spaces` folder next to the home
  Pi starts with (`~/.pi/spaces` for `~/.pi/agent`), or `PI_SPACES_DIR`.
- `/space` opens a picker of the other spaces and restarts Pi in the chosen
  one; without the interactive terminal it lists them. `/space list`,
  `/space new <name>`, `/space switch [<name>]`, `/space rename <old> <new>`
  and `/space remove <name>`. `base` is the home Pi started with. (#1, #4)
- The switch restarts Pi with the same options and moves every variable that
  points into the old home, so a program that runs Pi with its own home keeps
  working. (#1, #3)
- `pi --space <name>` starts Pi directly in a space, keeping the prompt and the
  session options. (#1)
- The active space in the status line.
- The optional `pi-space` command (`npm install -g`): a numbered picker,
  `pi-space <name> [pi args...]` and `pi-space list`. `PI_SPACES_COMMAND`
  chooses the program it runs. (#2)
- `remove` and `rename` refuse `base`, the active space, symlinks, a space that
  holds the current or base home, and a spaces folder that is the filesystem
  root, the home folder or the agent home.
