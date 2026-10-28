# pi-space

The `pi-space` command: pick a [Pi](https://pi.dev) space and start Pi in it, from your shell. It is the optional companion of the Pi extension [`@jals1212/pi-spaces`](https://github.com/jals1212/pi-spaces#readme), which holds the spaces themselves.

## Install

```sh
npm install -g @jals1212/pi-spaces-cli
```

Node 20 or later. The Pi extension `@jals1212/pi-spaces` must be installed in the home the command opens: `pi-space` only runs `pi --space <name>`, and the extension does the switch.

## Commands

| Command | What it does |
| --- | --- |
| `pi-space` | Shows a numbered list of spaces and starts Pi in the one you pick. |
| `pi-space <name> [pi args...]` | Starts Pi in that space (`base` for the home Pi starts with). |
| `pi-space list` | Lists the spaces. A space named `list` can still be opened from the picker. |
| `pi-space --help` | Shows the usage. |
| `pi-space --version` | Prints the version. |

## Another program that runs Pi

To start Pi through another program, set `PI_SPACES_COMMAND` in your shell profile; its words come before `--space`. Such a program usually has its own home, so point `PI_SPACES_DIR` at its spaces folder too, so `pi-space` lists the same spaces:

```sh
export PI_SPACES_COMMAND="my-launcher --"    # pi-space work → my-launcher -- --space work
export PI_SPACES_DIR=~/.my-launcher/spaces   # the spaces next to that program's home
```

| Variable | Meaning |
| --- | --- |
| `PI_SPACES_COMMAND` | The program to run, split on spaces, before `--space <name>`. Default: `pi`. |
| `PI_SPACES_DIR` | The spaces folder. A relative value is taken from your home folder. Default: `spaces` next to the base home. |
| `PI_CODING_AGENT_DIR` | Pi's agent home; its parent holds the default spaces folder. Default: `~/.pi/agent`. |

## Exit status

| Status | Meaning |
| --- | --- |
| 0 … | Pi's own exit status. |
| 1 | An unknown or invalid space, an out-of-range pick, or the program could not start. |
| 2 | No arguments and no terminal to pick in: the usage is printed. |

## More

Spaces, the `/space` commands in Pi, how switching works and safety: see the [main README](https://github.com/jals1212/pi-spaces#readme).

## License

MIT
