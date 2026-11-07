# Changelog

Each release of `pi-spaces` (published as `@jals1212/pi-spaces` up to 0.15.1). Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
commands and options and a patch version fixes.

## Unreleased

## 0.16.0

### Changed

- The package is now published as `pi-spaces`, without the `@jals1212` scope;
  `@jals1212/pi-spaces` stops at 0.15.1 and is deprecated. To move, replace
  `npm:@jals1212/pi-spaces` with `npm:pi-spaces` in the `packages` of every
  `settings.json` that declares it (the base home and each space), or run
  `pi remove npm:@jals1212/pi-spaces` and `pi install npm:pi-spaces`. Keep only
  one of the two: both together load `/space` twice. The library exports are
  now `pi-spaces/spaces` and `pi-spaces/config`.

## 0.15.1

### Fixed

- herdr-app sidebar: an agent no longer loses its space after the Herdr app is
  closed and opened. The `space` label was set once, and a set that failed while
  herdr-core was starting (or a core restarted under a running Pi) left the
  terminal without it. The session now follows `hc events` for its terminal and
  sets the label again when it is missing or changed, following the stream again
  with backoff when it ends. A label removed while the session lasts, by
  anything, comes back the same way.

## 0.15.0

### Documentation

- The README explains that the extension and the `pi-space` command are independent: use either one, or both, with what each one gives and cannot do alone.

## 0.14.0

### Added

- Herdr sidebar: the status line text (`🪐 <profile>/<name>`) also shows in Herdr's
  Agents sidebar. In a Herdr pane it is the pane's `$space` metadata token
  (30-second TTL, refreshed every 10 seconds, cleared when the session ends),
  shown by a `$space` row item; in a herdr-app terminal it is the terminal's
  `space` label (`hc label`), set once, removed when the session ends or moves
  to another terminal. Display only. The README shows how to add both to the
  sidebar.

## 0.13.0

### Added

- The config file can be TOML: a path ending in `.toml` is read as TOML (with
  `#` comments), any other as JSON as before. Both have the same keys and
  checks. TOML is parsed with the `smol-toml` dependency.
- `configFile(env, home)` returns the config file and, when there is one, the
  `config.json` that a `config.toml` in the same folder shadows.

### Changed

- The config file is looked up as `config.toml`, then `config.json`, in
  `~/.config/pi-spaces` (or `$XDG_CONFIG_HOME/pi-spaces`), then in
  `~/.pi-spaces`; with no file the answer of `configPath` is
  `~/.pi-spaces/config.toml` (it was `~/.pi-spaces/config.json`). An existing
  `config.json` keeps working where it is.
- When `config.toml` and `config.json` are in the same folder, `config.toml` is
  read and the extension warns that the `config.json` is ignored.

## 0.12.0

### Added

- A space is a root folder with its agent home inside it, always named `agent`:
  `<spaces folder>/<name>/agent` is `PI_CODING_AGENT_DIR` (and `{home}`) for every
  profile, as `~/.pi/agent` is for Pi's own home. `/space new` and
  `createSpace` make the root with `agent/settings.json`. Spaces made before,
  with no `agent/` folder, keep working as they are (their folder is the agent
  home); list, rename, remove, backups, `/space switch` and the active-space
  detection work for both layouts, and rename, remove and backups act on the
  root.
- `{space}` in `spaceEnv` values and in `commands` and `setup`: the space's root
  folder (the same folder as `{home}` for an old space; in base, the folder that
  holds the profile's `home`). `expandSpaceEnv`, `spaceEnvFor` and `setupCommand`
  take it as an optional last argument.
- `spaceHome(root)`, `isRooted(root)`, `AGENT` and `migrateSpace(...)` in
  `@jals1212/pi-spaces/spaces`: `migrateSpace` copies an old space to
  `.backups/<name>-<UTC time>`, then moves its content into `<root>/agent`,
  undoing the moves if one fails. See
  [Moving an old space](README.md#moving-an-old-space).

### Changed

- `createSpace` returns the space's root (as before) but writes
  `settings.json` in `<root>/agent`. `SwitchTarget` and `LaunchTarget` carry
  `spaceRoot`, and `targetHome` of a space with an `agent/` folder is that
  folder. `PI_SPACE_HOME` is the space's agent home.

## 0.11.3

### Added

- A preview image (`pi.image`) for the Pi package gallery, also shown at the
  top of the README.

## 0.11.2

### Fixed

- `/space switch` with a v2 profile runs the profile's `commands` (`commands.base`
  for base, `commands.space` or `<base> --space <name>` for a space) instead of
  starting the running Pi again, so a launcher's own setup for base is kept. A
  Pi started with `--space` no longer returns to that space after a switch.

## 0.11.1

### Changed

- The docs and the skill use a generic launcher in their examples; the README
  keeps one example profile for a real program.

## 0.11.0

### Added

- Config schema `pi-spaces.config/v2`: a profile has `commands` instead of
  `command`, `setup` and `homeless`. `commands.base` starts the base home as it
  is (the words after it, no `--space`); `commands.space` is the template of a
  space, with `{home}` and `{name}` (without it a space starts
  `<base> --space <name>`); `commands.setup` prepares a new space. For a v2
  profile `PI_SPACES_COMMAND` is `commands.space`, else `commands.base`, and
  `PI_SPACES_SETUP` is `commands.setup`. A v1 file keeps working unchanged;
  [Moving from v1 to v2](README.md#moving-from-v1-to-v2) shows the edit. An
  older pi-spaces refuses a v2 file as "needs a newer pi-spaces", so update
  every home before switching the file.
- The config file accepts `//` and `/* */` comments, in both schemas.

### Changed

- The `SCHEMA` export of `@jals1212/pi-spaces/config` is now
  `pi-spaces.config/v2`; `SCHEMA_V1` is the first schema. The "needs a newer
  pi-spaces" message names both: `this one reads "pi-spaces.config/v1" and
  "pi-spaces.config/v2"`, and a v2 profile's unknown-key message lists
  `"home", "commands", "dir" and "spaceEnv"`.
- The `<pi_space>` prompt section says `pi-space <profile>/<name>` starts a
  space when the command has `{name}` as well as `{home}`.

## 0.10.0

### Added

- A profile may list `homeless` words (`"homeless": ["upgrade"]`): with one of
  them first, `pi-space` runs the profile's `command` without its home part
  and without `--space`, so `pi-space gentle/base upgrade` runs
  `gentle-shell upgrade`. A non-empty list of words with no spaces; anything
  else is refused like any wrong key. An older pi-spaces refuses a file with
  `homeless` as an unknown key, so update every home before adding it.

### Fixed

- The README and the skill no longer say that `pi-space gentle/base upgrade`
  runs gentle-shell's `upgrade` through `--home`: gentle-shell recognizes it
  only as its first word, so after `--home` it goes to Pi. `homeless` covers it.

## 0.9.0

### Added

- A profile `command` may contain `{home}` and `{name}`
  (`"gentle-shell --home {home}"`): `pi-space` then runs it directly in the
  space's home, without `--space`, so the program's own commands work
  (`pi-space gentle/base upgrade`). The `<pi_space>` section of the system
  prompt then says that `pi-space <profile>/<name>` starts a space, not
  `<command> --space <name>`.
- The config file is also found in `~/.config/pi-spaces/config.json`
  (`$XDG_CONFIG_HOME/pi-spaces/config.json` when `XDG_CONFIG_HOME` is an
  absolute path; on Windows `%USERPROFILE%\.config\pi-spaces\config.json`),
  so it can live in your dotfiles without `PI_SPACES_CONFIG`. Order:
  `PI_SPACES_CONFIG`, then that file when it exists, then
  `~/.pi-spaces/config.json` as before; with both files the XDG one wins, and
  nothing is moved. `configPath(env, home)` takes an optional existence check.

## 0.8.0

### Changed

- 🪐 is pi-spaces' emoji. The status line shows the active space as
  `🪐 <profile>/<name>` instead of `◆ <name>`, the same name `pi-space`
  takes, with the profile of the running Pi (`pi` when no profile matches its
  base home); in the base home opened by pi-spaces it shows
  `🪐 <profile>/base` instead of `◆ base`.

## 0.7.0

### Changed

- The setup hint of `/space new` names the space with its profile, as
  `pi-space` now requires: `pi-space setup <profile>/<name>`, where the
  profile is the one of the running Pi (`pi` when no profile matches its base
  home). `/space` itself still takes the bare name.

### Fixed

- The built-in `pi` profile no longer takes another profile's home: inside
  the Pi of a program whose profile names its `home`, `PI_CODING_AGENT_DIR`
  holds that home, and `pi` now keeps `~/.pi/agent` (its spaces in
  `~/.pi/spaces`) instead of pointing at that program's home and spaces.

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

- `completion` is a reserved name, for `pi-space completion`. A space already
  named `completion` is no longer listed; rename its folder by hand.
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
