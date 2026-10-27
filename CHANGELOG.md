# Changelog

## Unreleased

- `/space list`, `/space new <name>`, `/space remove <name>` and `/space switch <name>`: named Pi agent homes in a `spaces` folder next to the home Pi starts with (`~/.pi/spaces` for `~/.pi/agent`), or `PI_SPACES_DIR`.
- The active space shows in the status line.
- `/space` with no arguments opens the switch picker (it lists without the interactive terminal); `/space switch` with no name opens the same picker; `/space rename <old> <new>` renames a space.
- `pi --space <name>` starts Pi directly in a space.
- Optional `pi-space` CLI (`npm i -g`): a picker, `pi-space <name> [args]` and `pi-space list`. `PI_SPACES_COMMAND` chooses the program it runs.
- `/space switch` restarts Pi with the same options in the chosen space; `base` returns to the home Pi started with.
