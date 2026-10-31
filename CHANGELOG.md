# Changelog

Each release of `@jals1212/pi-spaces`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
commands and options and a patch version fixes.

## Unreleased

## 0.6.0

### Added

- Profiles in a config file (`~/.pi-spaces/config.json`, or `PI_SPACES_CONFIG`):
  named descriptions of a program that runs Pi, with its base `home`,
  `command`, spaces `dir`, `setup` command and `spaceEnv`. The format carries a
  version (`"schema": "pi-spaces.config/v1"`); a newer version is refused with
  a message that it needs a newer pi-spaces, and unknown keys are refused. A
  built-in `pi` profile always exists and can be replaced. See the README.
- `spaceEnv`: variables that exist only in spaces. Entering a space sets them
  (`{home}` and `{name}` filled in) and moving between spaces recomputes
  them. Going back to `base` puts back the values the base home had (kept in `PI_SPACES_BASE_ENV` meanwhile). Without
  `spaceEnv`, whatever a program keeps outside its agent home stays shared with
  the base home, as before. The variables pi-spaces sets itself are refused.
- The extension applies the profile whose `home` is the base home: its
  `spaceEnv` on `/space switch` and `pi --space`, its `dir` as the spaces
  folder, and `/space new` names `pi-space setup <name>` when it has a `setup`.
- `@jals1212/pi-spaces/config` exports the loader (`loadConfig`, `configPath`,
  `profileByName`, `profileForHome`, `spaceEnvFor`, `activeProfile`,
  `ConfigError`) for the `pi-space` command.

### Changed

- The spaces folder is `PI_SPACES_DIR`, else the matching profile's `dir`, else
  `spaces` next to the base home. `spacesDir` takes the profile's dir as an
  optional third argument.
- `relaunchEnv` and `planStartup` take an optional `spaceEnv`; without it they
  behave exactly as before.
- A config file that cannot be used never stops Pi: the extension warns once
  when the session starts and behaves as with no file.

## 0.5.0

### Added

- `/space new` names `pi-space setup <name>` when `PI_SPACES_SETUP` holds a
  setup command, so a space a program needs prepared is not entered bare.

### Changed

- `setup` is a reserved name, as the other command words are. A space already
  named `setup` is no longer listed; rename its folder by hand.

## 0.4.1

### Changed

- The status line shows `◆ base` in the base home when pi-spaces opened it
  (`pi --space base`, `pi-space base`, or a switch back to base); Pi started
  plainly still shows nothing there.

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
