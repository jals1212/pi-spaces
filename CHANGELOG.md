# Changelog

Each release of `@jals1212/pi-spaces`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
commands and options and a patch version fixes.

## Unreleased

## 0.4.0

### Added

- `pi --space <name> <command> [args...]` runs one of Pi's package commands
  (`install`, `remove`, `uninstall`, `update`, `list`) in a space, or in the
  base home with `base`, through the same Pi: `pi --space work update
  --extensions`. Options before `--space`, such as a launcher's own `-e`, are
  left out, since Pi runs a package command only as its first argument.

### Changed

- The command words `list`, `new`, `remove`, `rename`, `switch`, `update`,
  `install` and `uninstall` are reserved and can no longer name a space, so
  `pi-space <name>` never reads as a command. A folder with such a name in the
  spaces folder is no longer listed as a space.

## 0.3.0

### Added

- Pi knows the space it runs in. Every Pi with the extension sets
  `PI_SPACE` (unset in the base home), `PI_SPACE_HOME` (its agent home) and
  `PI_SPACES_COMMAND` (its configured value, else `pi`), with or without a
  switch, and the system prompt gets a `<pi_space>` section with the same
  facts. `spaceInfo`, `exportSpaceInfo` and `spacePrompt` in the core build
  them.
- A `pi-spaces` skill, declared in the package, that tells agents what a
  space is, how to read the current space, home and command, and which
  `/space` or `pi-space` action to use.

### Changed

- The status line shows the active space as `◆ <name>` instead of
  `space: <name>`, so it stands out among other extensions' statuses.

## 0.2.0

### Added

- `/space remove` asks, after the confirmation, whether to keep a backup:
  the space moves to `.backups/<name>-<UTC time>` in the spaces folder, and
  keeping one is the first choice. `--yes` keeps a backup, and `--no-backup`
  deletes without one. `backupSpace` and `BACKUPS` in the core do it, with the
  same checks as `removeSpace`.

### Changed

- `/space remove <name> --yes` now keeps a backup instead of deleting the
  space; add `--no-backup` to delete it as before.

### Fixed

- `/space new` copies a local path that loads another copy of this package
  (a folder whose `package.json` is named `@jals1212/pi-spaces`) instead of
  writing the folder of the copy that runs.
- `/space remove` and `backupSpace` report a backup that cannot be written
  (for example a read-only spaces folder) as an error that says the space was
  not removed and offers `--no-backup`, instead of a raw filesystem error.
- `findOwnDeclaration` takes an optional fallback, answered when nothing
  matches, and an empty package folder matches a local path only by its
  `package.json` name.

## 0.1.1

### Changed

- The `pi-space` command moved to its own package, `@jals1212/pi-spaces-cli`, so each one is installed and updated on its own; this package is now only the Pi extension.

### Fixed

- The README, the `pi-space --help` text and the examples name no particular
  program that runs Pi; they use a generic `my-launcher`. 0.1.0 is withdrawn
  from npm: use 0.1.1.

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
