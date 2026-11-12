// The optional `pi-space` command: pick a space and start Pi in it, and manage the spaces and their packages.
// It passes `--space <name>` (and, for a package command, Pi's command after it) and the extension does the switch,
// but the Pi it starts runs as if started from a plain terminal for the named profile, whatever Pi the caller is in:
// the caller's space (PI_SPACES_BASE_HOME, PI_SPACE, PI_SPACE_HOME, PI_SPACES_BASE_ENV, its spaceEnv values and the
// paths inside its folder) is unwound back to its base, and PI_CODING_AGENT_DIR is the profile's home. The setup
// command, which is not Pi and does no switch, gets the space's own home and variables on top of that same base.
// A command with {home} (`my-launcher --home {home}`) is the program itself: it runs in the space's home with no
// --space; the words after the space come after the command, so a program's own command works only where the program
// takes it after its home option (`pi-space ml/base setup --dry-run` does; a command that the program recognizes only
// as its first word, such as `upgrade`, does not); see startFor. A first word of the profile's `homeless` list runs the command
// without its home part and with no --space instead (`my-launcher upgrade`); see homelessStart.
// Every space is named <profile>/<name>; the profile of the config file stands in for the command, the spaces folder and the setup.
// A space is a root folder, <spaces folder>/<name>, with its agent home inside it, <root>/agent (an old space has no agent
// folder and its root is its agent home; spaceHome tells which). {home} is the agent home, {space} the root.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { PINNED_MARK, type PickerItem, type PickerTerminal, runPicker } from "./picker.ts";
import {
	BACKUPS,
	BASE,
	backupSpace,
	checkRemovable,
	createSpace,
	type Env,
	findOwnDeclaration,
	hasSetupCommand,
	isRooted,
	listSpaces,
	migrateSpace,
	type PackageDeclaration,
	removeSpace,
	renameSpace,
	SpaceError,
	samePath,
	spaceHome,
	validateName,
} from "pi-spaces/spaces";
import { findPin, homeRefusal, PinError, pinnedMessage, pinRoot, readPin, removePin, unpinnedMessage, writePin } from "pi-spaces/pin";
import {
	ConfigError,
	type Config,
	configFile as findConfigFile,
	configPath,
	ignoredWarning,
	isToml,
	loadConfig,
	type Profile,
	profileByName,
	profileForHome,
	profileNames,
	SCHEMA,
	spaceEnvFor,
} from "pi-spaces/config";

export const USAGE = `Usage: pi-space [--command <cmd>] [--dir <path>] [--setup <cmd>] [--config <path>] [<space> [pi args...] | <command> ...]
       pi-space --help | --version
A <space> is <profile>/<name>: a profile of the config file (pi is always there), then the space; base is a space too, as <profile>/base.
  pi-space                                     start the space pinned to this folder (pi-space pin), else pick a space and start Pi in it
  pi-space pick                                pick a space and start Pi in it, even where one is pinned
  pi-space pin [<space>|--show]                pin a space to this repository (.pi/pi-space, ignored by git); alone, pick it (⌂ marks the pinned one)
  pi-space unpin                               remove the space pinned to this repository
  pi-space <space> [pi args...]                start Pi in a space (<profile>/base is the home that profile's Pi starts with);
                                               words with no option among them are one message: pi-space pi/work fix the tests
  pi-space list                                list the spaces of every profile
  pi-space list <space|--every>                list the packages of a space
  pi-space new <space>                         create a space, then run the profile's setup command in it when there is one
                                               (asks whether to declare the extension in it; --extension or --no-extension answers)
  pi-space setup <space|--every>               run the setup command in a space or base, or in base and every space
  pi-space rename <space> <new>                rename a space; the new name is bare or keeps the profile (<profile>/<new>)
  pi-space remove <space>                      delete a space and everything in it, after asking, and keep a backup in .backups unless told not to
                                               (--yes skips the questions; --no-backup deletes without a backup)
  pi-space migrate <space|--every>             move an old space's content into its agent/ folder, after a copy in .backups (never base)
  pi-space update <space|--every>              update the packages of a space (more words go to Pi: --extensions, --all, a source)
  pi-space install <space|--every> <source>    install a package in a space (more words go to Pi)
  pi-space uninstall <space|--every> <source>  remove a package from a space (more words go to Pi)
  pi-space init                                write a config file with the built-in pi profile in comments
  pi-space completion zsh                      print the zsh completion script (source <(pi-space completion zsh))
  pi-space completion powershell               print the PowerShell completion script (pi-space completion powershell | Out-String | Invoke-Expression)
  pi-space <command> --help                    the help of one command
  pi-space --help                              print this help
  pi-space --version                           print the version
  --every takes the place of the space: <profile>/--every runs in that profile's base (not for migrate) and spaces, --every alone in every profile;
  a failure does not stop the rest, and the exit status is 1 if any failed.
Options before the command, for this call only:
  --command <cmd>                              the program to run instead of the profile's command, e.g. "my-launcher --" (for one profile)
  --dir <path>                                 the spaces folder instead of the profile's; the Pi it starts gets it too (for one profile)
  --setup <cmd>                                the setup command instead of the profile's; {home}, {space} and {name} become the space's agent home, its root and its name
  --config <path>                              the config file instead of $PI_SPACES_CONFIG (default: ~/.config/pi-spaces/config.toml or .json, else ~/.pi-spaces/config.toml or .json); the Pi it starts gets it too
`;

/** This package's version; package.json sits one folder above both src/ and dist/. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** --command, --dir, --setup and --config: for this call only, so nothing has to be exported into the shell. */
export interface CallOptions {
	command?: string;
	dir?: string;
	setup?: string;
	config?: string;
}

/** The Pi commands that pi-space runs in one space or in every space. */
export type PackageVerb = "list" | "update" | "install" | "uninstall";

/** `<profile>/<name>` (or `<profile>/base`, or `<profile>/--every` for one profile), or every space of every profile: base first, then the spaces in order. */
export type PackageTarget = { name: string } | { every: true };

const PACKAGE_VERBS: readonly string[] = ["list", "update", "install", "uninstall"];

/** The old options, and the command that replaced each. */
const REPLACED = {
	"--new": "pi-space new <profile>/<name>",
	"--remove": "pi-space remove <profile>/<name> [--yes] [--no-backup]",
	"--profile": "pi-space <profile>/<name>",
} as const;

export type CliCommand = (
	| { kind: "help" }
	| { kind: "command-help"; command: string }
	| { kind: "version" }
	| { kind: "unknown-option"; option: string }
	| { kind: "replaced"; option: string; instead: string }
	| { kind: "list" }
	| { kind: "packages"; verb: PackageVerb; target: PackageTarget; args: string[] }
	| { kind: "new"; name: string; extension?: boolean }
	| { kind: "setup"; target: PackageTarget }
	| { kind: "migrate"; target: PackageTarget }
	| { kind: "rename"; from: string; to: string }
	| { kind: "remove"; name: string; yes: boolean; backup: boolean }
	| { kind: "init" }
	| { kind: "completion"; shell?: string }
	| { kind: "complete"; words: string[] }
	| { kind: "picker" }
	| { kind: "pick" }
	| { kind: "pin"; name?: string; show?: boolean }
	| { kind: "unpin" }
	| { kind: "usage" }
	| { kind: "launch"; name: string; args: string[] }
) &
	CallOptions;

const CALL_OPTIONS = { "--command": "command", "--dir": "dir", "--setup": "setup", "--config": "config" } as const;

function isHelpFlag(word: string): boolean {
	return word === "--help" || word === "-h";
}

/** What each call option is, for the help of the commands it applies to. */
const CALL_HELP: Record<keyof CallOptions, [label: string, text: string]> = {
	command: ["--command <cmd>", 'the program to run instead of the profile\'s command, e.g. "my-launcher --"; for one profile'],
	dir: ["--dir <path>", "the spaces folder instead of the profile's; the Pi it starts gets it too; for one profile"],
	setup: ["--setup <cmd>", "the setup command instead of the profile's; {home}, {space} and {name} become the space's agent home, its root and its name"],
	config: ["--config <path>", "the config file instead of $PI_SPACES_CONFIG (default: ~/.config/pi-spaces/config.toml or .json, else ~/.pi-spaces/config.toml or .json)"],
};

/** The help of one command; the summary is the one line completion shows next to it. */
interface CommandHelp {
	summary: string;
	/** What follows `pi-space ` on the Usage line. */
	usage: string;
	/** More about what it does, after the summary. */
	about: string[];
	args: [label: string, text: string][];
	/** Its own options; --help is added to every command. */
	options: { flag: string; alias?: string; text: string }[];
	/** The call options that apply to it. */
	calls: (keyof CallOptions)[];
	examples: string[];
}

const PI_ARGS: [string, string] = ["[pi args...]", "more words go to Pi, e.g. --extensions, --all or a source"];
const NAME_OR_EVERY: [string, string][] = [
	["<space>", "<profile>/<name>: a space of a profile, or <profile>/base"],
	["<profile>/--every", "that profile's base, then its spaces in turn; a failure does not stop the rest, and the exit status is 1 if any failed"],
	["--every", "the same in every profile: pi first, then the others in alphabetical order"],
];

/** The commands, in the order completion lists them. They are reserved words: a space is always named with its profile, so none of them is read as a space. */
const COMMANDS: Record<string, CommandHelp> = {
	list: {
		summary: "list the spaces, or the packages of one",
		usage: "list [<space|--every>]",
		about: ["Alone it lists the spaces of every profile. With a space it runs Pi's list in it; with <profile>/--every, in that profile's base and then its spaces; with --every, in every profile's."],
		args: NAME_OR_EVERY,
		options: [],
		calls: ["command", "dir", "config"],
		examples: ["pi-space list", "pi-space list pi/work", "pi-space list pi/--every", "pi-space list --every"],
	},
	new: {
		summary: "create a space",
		usage: "new <space> [--extension|--no-extension]",
		about: [
			"The space is a folder with its agent home, agent/, inside it. It runs the profile's setup command in it when there is one, and does not start Pi.",
			"In a terminal it asks whether agent/settings.json declares the Pi extension pi-spaces, which Pi then installs in the space (Enter is yes); without a terminal it declares it. pi-space works without it when the profile's space command has {home}.",
		],
		args: [["<space>", "<profile>/<name>: the profile and the name of the new space"]],
		options: [
			{ flag: "--extension", text: "declare the extension without asking" },
			{ flag: "--no-extension", text: "do not declare it: agent/settings.json is empty" },
		],
		calls: ["dir", "setup", "config"],
		examples: ["pi-space new pi/work", "pi-space new gentle/work --no-extension", "pi-space --setup 'my-launcher --home {home} setup' new pi/work"],
	},
	setup: {
		summary: "run the setup command in a space or in base",
		usage: "setup <space|--every>",
		about: ["It needs a setup command: the profile's \"setup\" or --setup (pi has none by default). In base, {home} is the profile's home and {name} is base."],
		args: [
			["<space>", "<profile>/<name>: a space of a profile, or <profile>/base"],
			["<profile>/--every", "that profile's base, then its spaces in turn; a failure does not stop the rest, and the exit status is 1 if any failed"],
			["--every", "the base and spaces of every profile that has a setup command (or of all, with --setup)"],
		],
		options: [],
		calls: ["dir", "setup", "config"],
		examples: ["pi-space setup pi/work", "pi-space setup ml/base", "pi-space setup pi/--every", "pi-space setup --every", "pi-space --setup 'my-launcher --home {home} setup' setup --every"],
	},
	rename: {
		summary: "rename a space",
		usage: "rename <space> <new>",
		about: ["It refuses what remove refuses: base, the space you are in, and a space that holds the base home. A space keeps its profile."],
		args: [
			["<space>", "<profile>/<name>: the space to rename"],
			["<new>", "its new name, bare or with the same profile"],
		],
		options: [],
		calls: ["dir", "config"],
		examples: ["pi-space rename pi/work client", "pi-space rename pi/work pi/client"],
	},
	remove: {
		summary: "delete a space, keeping a backup",
		usage: "remove <space> [--yes|-y] [--no-backup]",
		about: ["It deletes the space and everything in it, after asking, and keeps a backup in .backups unless told not to."],
		args: [["<space>", "<profile>/<name>: the space to delete"]],
		options: [
			{ flag: "--yes", alias: "-y", text: "do not ask; keep a backup" },
			{ flag: "--no-backup", text: "delete without a backup" },
		],
		calls: ["dir", "config"],
		examples: ["pi-space remove pi/work", "pi-space remove pi/work --yes", "pi-space remove pi/work --yes --no-backup"],
	},
	migrate: {
		summary: "move an old space into its agent folder",
		usage: "migrate <space|--every>",
		about: [
			"A space is a folder with its agent home, agent/, inside it. An old space has no agent/ folder and its folder is its agent home; migrate moves its content into agent/, after a copy of the whole space in .backups, and the space keeps its name.",
			"It never touches base, the space you are in, or a space that already has agent/.",
		],
		args: [
			["<space>", "<profile>/<name>: a space of a profile"],
			["<profile>/--every", "every space of that profile, never base; one that already has agent/ is skipped, a failure does not stop the rest, and the exit status is 1 if any failed"],
			["--every", "every space of every profile"],
		],
		options: [],
		calls: ["dir", "config"],
		examples: ["pi-space migrate pi/work", "pi-space migrate pi/--every", "pi-space migrate --every"],
	},
	update: {
		summary: "update the packages of a space",
		usage: "update <space|--every> [pi args...]",
		about: ["It runs Pi's update in a space, in a profile's base and then its spaces, or in every profile's."],
		args: [...NAME_OR_EVERY, PI_ARGS],
		options: [],
		calls: ["command", "dir", "config"],
		examples: ["pi-space update pi/work", "pi-space update pi/base --extensions", "pi-space --command 'my-launcher --' update pi/--every", "pi-space update --every"],
	},
	install: {
		summary: "install a package in a space",
		usage: "install <space|--every> <source> [pi args...]",
		about: ["It runs Pi's install in a space, in a profile's base and then its spaces, or in every profile's."],
		args: [...NAME_OR_EVERY, ["<source>", "the package to install, e.g. npm:some-package"], PI_ARGS],
		options: [],
		calls: ["command", "dir", "config"],
		examples: ["pi-space install pi/work npm:some-package", "pi-space install pi/--every npm:some-package", "pi-space install --every npm:some-package"],
	},
	uninstall: {
		summary: "remove a package from a space",
		usage: "uninstall <space|--every> <source> [pi args...]",
		about: ["It runs Pi's uninstall (its alias of remove) in a space, in a profile's base and then its spaces, or in every profile's."],
		args: [...NAME_OR_EVERY, ["<source>", "the package to remove, e.g. npm:some-package"], PI_ARGS],
		options: [],
		calls: ["command", "dir", "config"],
		examples: ["pi-space uninstall pi/work npm:some-package", "pi-space uninstall pi/--every npm:some-package", "pi-space uninstall --every npm:some-package"],
	},
	init: {
		summary: "write a config file with the built-in pi profile in comments",
		usage: "[--config <path>] init",
		about: [
			"It writes the config file (schema v2) with no profiles of its own, and a header of comments that shows how the built-in pi profile is set up and a profile for another program.",
			"The file is TOML (~/.pi-spaces/config.toml when there is no config file yet), or JSON when --config names a path that does not end in .toml.",
			"It refuses a file that already exists, and never reads it.",
		],
		args: [],
		options: [],
		calls: ["config"],
		examples: ["pi-space init", "pi-space --config ~/dotfiles/pi-spaces.toml init", "pi-space --config ~/dotfiles/pi-spaces.json init"],
	},
	completion: {
		summary: "print the shell completion script",
		usage: "completion <shell>",
		about: ["Supported shells: zsh, powershell."],
		args: [["<shell>", "zsh or powershell"]],
		options: [],
		calls: [],
		examples: ["pi-space completion zsh", "source <(pi-space completion zsh)", "pi-space completion powershell", "pi-space completion powershell | Out-String | Invoke-Expression"],
	},
	pin: {
		summary: "pin a space to this folder, or pick one to pin",
		usage: "pin [<space>|--show]",
		about: [
			"With a space it writes .pi/pi-space/space in the root of the git repository (else in the current folder), next to a .gitignore that ignores that folder, itself included, so nothing shows in git status; the rest of .pi is never touched.",
			"A bare pi-space in that folder or below then starts the pinned space at once; a space named on the command line wins, and pi-space pick still opens the picker.",
			`Alone, on a terminal, it opens the picker of every profile's spaces, the cursor on the pinned one (marked ${PINNED_MARK}), and pins the one you choose; Esc changes nothing. Without a terminal, or with --show, it prints the space pinned here and the file it comes from.`,
			"The marker is looked for from the current folder upwards; the home folder is skipped (~/.pi is Pi's own folder) and cannot be pinned.",
		],
		args: [["<space>", "<profile>/<name>: a space of a profile, or <profile>/base; it must exist"]],
		options: [{ flag: "--show", text: "print the space pinned here, even on a terminal" }],
		calls: ["dir", "config"],
		examples: ["pi-space pin gentle/work", "pi-space pin pi/base", "pi-space pin", "pi-space pin --show"],
	},
	unpin: {
		summary: "remove the space pinned to this folder",
		usage: "unpin",
		about: [
			"It removes .pi/pi-space/space from the root of the git repository (else the current folder), the .gitignore pin wrote, and the folder when it is then empty (and .pi when nothing else is in it); the rest of .pi is never touched.",
			"A marker of a folder above is named, never removed.",
		],
		args: [],
		options: [],
		calls: [],
		examples: ["pi-space unpin"],
	},
	pick: {
		summary: "pick a space even where one is pinned",
		usage: "pick",
		about: ["The picker of a bare pi-space, with the cursor on the pinned space when there is one."],
		args: [],
		options: [],
		calls: ["setup", "config"],
		examples: ["pi-space pick"],
	},
};

/** --help after a command; GENERAL_OPTIONS has the --help that comes first. */
const HELP_OPTION = { flag: "--help", alias: "-h", text: "the help of this command" };

/** The options that stand alone in first place, as completion describes them. */
const GENERAL_OPTIONS: [flag: string, text: string][] = [
	["--help", "print the help, or a command's: --help <command>"],
	["--version", "print the version"],
];

/** The help of one command: usage, what it does, arguments, options, the call options that apply, and examples. */
function commandHelp(name: string): string {
	const help = COMMANDS[name];
	const options = [...help.options, HELP_OPTION].map((option): [string, string] => [option.alias ? `${option.flag}, ${option.alias}` : option.flag, option.text]);
	const calls = help.calls.map((call): [string, string] => CALL_HELP[call]);
	const width = Math.max(...[...help.args, ...options, ...calls].map(([label]) => label.length)) + 2;
	const rows = (list: [string, string][]) => list.map(([label, text]) => `  ${label.padEnd(width)}${text}`);
	const sections: string[][] = [
		[`Usage: pi-space ${help.usage}`],
		[`${help.summary[0].toUpperCase()}${help.summary.slice(1)}.`, ...help.about],
		...(help.args.length > 0 ? [["Arguments:", ...rows(help.args)]] : []),
		["Options:", ...rows(options)],
		...(calls.length > 0 ? [["Call options (before the command, for this call only):", ...rows(calls)]] : []),
		["Examples:", ...help.examples.map((example) => `  ${example}`)],
	];
	return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

/**
 * The call options (--command, --dir, --setup, --config) come first; after a space name every argument belongs to Pi.
 * The commands (list, new, setup, remove, rename, migrate, update, install, uninstall, completion) are reserved words, so they
 * are read before a name: the core never lets a space have one of them as its name (migrate and init are commands of this CLI
 * only, and a space is always named with its profile, so `pi/migrate` is still a space). `__complete` is the hidden
 * command the completion script calls; it starts with "_", which no space name does.
 * A space name never starts with "-", so any other option in first place is unknown, not a name.
 */
export function parseCli(args: string[]): CliCommand {
	const options: CallOptions = {};
	let index = 0;
	while (Object.hasOwn(CALL_OPTIONS, args[index] ?? "")) {
		const key = CALL_OPTIONS[args[index] as keyof typeof CALL_OPTIONS];
		const value = args[index + 1];
		// A blank value is as good as none: it would name no program, folder or command.
		if (!value?.trim() || options[key] !== undefined) return { kind: "usage" };
		options[key] = value;
		index += 2;
	}
	const command = parseCommand(args.slice(index));
	return command.kind === "usage" ? command : { ...command, ...options };
}

function parseCommand(args: string[]): CliCommand {
	const [first, ...rest] = args;
	if (first === undefined) return { kind: "picker" };
	if (isHelpFlag(first)) return parseHelp(rest);
	if (first === "--version" || first === "-v") return { kind: "version" };
	if (Object.hasOwn(REPLACED, first)) return { kind: "replaced", option: first, instead: REPLACED[first as keyof typeof REPLACED] };
	if (first.startsWith("-")) return { kind: "unknown-option", option: first };
	// --help after a command word is that command's help; after a space name it belongs to Pi (the launch below).
	if (Object.hasOwn(COMMANDS, first) && rest.some(isHelpFlag)) return { kind: "command-help", command: first };
	if (first === "list" && rest.length === 0) return { kind: "list" };
	if (PACKAGE_VERBS.includes(first)) return parsePackages(first as PackageVerb, rest);
	if (first === "new") {
		const flags = rest.filter((arg) => arg.startsWith("-"));
		const names = rest.filter((arg) => !arg.startsWith("-"));
		if (names.length !== 1 || flags.length > 1 || flags.some((flag) => flag !== "--extension" && flag !== "--no-extension")) return { kind: "usage" };
		return flags.length === 1 ? { kind: "new", name: names[0], extension: flags[0] === "--extension" } : { kind: "new", name: names[0] };
	}
	if (first === "setup" || first === "migrate") return parseTarget(first, rest);
	if (first === "init") return rest.length === 0 ? { kind: "init" } : { kind: "usage" };
	if (first === "pick" || first === "unpin") return rest.length === 0 ? { kind: first } : { kind: "usage" };
	if (first === "pin") {
		if (rest.length > 1) return { kind: "usage" };
		if (rest[0] === "--show") return { kind: "pin", show: true };
		if (rest[0]?.startsWith("-")) return { kind: "unknown-option", option: rest[0] };
		return rest.length === 1 ? { kind: "pin", name: rest[0] } : { kind: "pin" };
	}
	if (first === "completion") return rest.length <= 1 ? { kind: "completion", ...(rest.length === 1 ? { shell: rest[0] } : {}) } : { kind: "usage" };
	if (first === "__complete") return { kind: "complete", words: rest };
	if (first === "rename") return rest.length === 2 ? { kind: "rename", from: rest[0], to: rest[1] } : { kind: "usage" };
	if (first === "remove") {
		const flags = rest.filter((arg) => arg.startsWith("-"));
		const names = rest.filter((arg) => !arg.startsWith("-"));
		const yes = flags.filter((flag) => flag === "--yes" || flag === "-y").length;
		const noBackup = flags.filter((flag) => flag === "--no-backup").length;
		if (names.length !== 1 || yes > 1 || noBackup > 1 || yes + noBackup !== flags.length) return { kind: "usage" };
		return { kind: "remove", name: names[0], yes: yes === 1, backup: noBackup === 0 };
	}
	return { kind: "launch", name: first, args: rest };
}

/** `--help` alone is the general help; `--help <command>` is that command's. */
function parseHelp(rest: string[]): CliCommand {
	if (rest.length === 0) return { kind: "help" };
	if (rest.length === 1) return { kind: "command-help", command: rest[0] };
	return { kind: "usage" };
}

/** `setup <name>` or `setup --every`, and the same for migrate: exactly one argument. */
function parseTarget(kind: "setup" | "migrate", rest: string[]): CliCommand {
	if (rest.length !== 1) return { kind: "usage" };
	if (rest[0] === "--every") return { kind, target: { every: true } };
	if (rest[0].startsWith("-")) return { kind: "unknown-option", option: rest[0] };
	return { kind, target: { name: rest[0] } };
}

/**
 * `<verb> <name|--every> [args...]`. list takes nothing after the target; install and uninstall need a source
 * (the first argument after it); update may have nothing, which is Pi's own default.
 */
function parsePackages(verb: PackageVerb, rest: string[]): CliCommand {
	const [first, ...args] = rest;
	if (first === undefined) return { kind: "usage" };
	if (first !== "--every" && first.startsWith("-")) return { kind: "unknown-option", option: first };
	if (verb === "list" && args.length > 0) return { kind: "usage" };
	if ((verb === "install" || verb === "uninstall") && args.length === 0) return { kind: "usage" };
	return { kind: "packages", verb, target: first === "--every" ? { every: true } : { name: first }, args };
}

/** Pi's own commands (docs/cli.md): as the first word they are a command with arguments, never the start of a message. */
const PI_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]);

/**
 * The words after a space, as the started Pi gets them. Pi takes each word as a separate message, and an unquoted
 * prompt reaches pi-space as one word per argument; so when no word is an option for Pi (none starts with "-"),
 * the words are joined into one message, with the @files apart before it in their order. With any option, or one
 * word at most, or when the first word is one of Pi's own commands (`install npm:x`), they are kept as they are.
 */
export function promptArgs(args: string[]): string[] {
	if (args.length < 2 || args.some((arg) => arg.startsWith("-")) || PI_COMMANDS.has(args[0])) return args;
	const files = args.filter((arg) => arg.startsWith("@"));
	const message = args.filter((arg) => !arg.startsWith("@")).join(" ");
	return message === "" ? files : [...files, message];
}

/**
 * The program and arguments that start Pi in a space: PI_SPACES_COMMAND of this env (default pi) plus --space <name>.
 * Throws when the command has an unclosed quote.
 */
export function launchCommand(env: Env, name: string, args: string[]): { program: string; args: string[] } {
	const [program = "pi", ...prefix] = splitCommand(env.PI_SPACES_COMMAND ?? "");
	return { program, args: [...prefix, "--space", name, ...args] };
}

/** Whether the settled command (this scope's PI_SPACES_COMMAND) has {home}: it is then run in the space's home, with no --space. */
function hasHomeCommand(env: Env): boolean {
	return (env.PI_SPACES_COMMAND ?? "").includes("{home}");
}

type Start = { program: string; args: string[]; env: Env | undefined };

/**
 * The program, arguments and environment that start one space (or base) of a scope with `words` after it, in this order:
 * 1. v2 base: commands.base as it is (baseStart).
 * 2. v2 space whose commands.space has no {home}: the template filled in, with the plain environment, since the
 *    program switches itself (`my-launcher -- --space {name}`).
 * 3. A command without {home} (v1, or v2 without commands.space, whose command is base): `<command> --space <name>`,
 *    with the plain environment (launchCommand); Pi does the switch.
 * 4. A command with {home} (v1, or a v2 commands.space with it): filled in and run in the home with no --space; base
 *    as in 1, a space with the environment the extension's relaunch would give it from base.
 * Throws when the command has an unclosed quote.
 */
function startFor(scope: Scope, name: string, words: string[]): Start {
	const { io, profile, commands } = scope;
	if (commands !== undefined && name === BASE) return baseStart(scope, commands.base, words);
	if (commands?.space !== undefined && !commands.space.includes("{home}")) {
		const root = rootOf(scope, name);
		const { program, args } = setupCommand(commands.space, spaceHome(root), name, root);
		return { program, args: [...args, ...words], env: io.childEnv };
	}
	if (!hasHomeCommand(io.env)) return { ...launchCommand(io.env, name, words), env: io.childEnv };
	const template = io.env.PI_SPACES_COMMAND ?? "";
	if (name === BASE) return baseStart(scope, template, words);
	const root = rootOf(scope, name);
	const home = spaceHome(root);
	const { program, args } = setupCommand(template, home, name, root);
	const plain = io.childEnv ?? io.env;
	const env: Env = { ...plain, ...spaceEnvFor(profile, home, name, root), PI_CODING_AGENT_DIR: home, PI_SPACE: name, PI_SPACE_HOME: home, PI_SPACES_BASE_HOME: profile.home };
	// The base's own values of the spaceEnv variables, as relaunchEnv keeps them to put back on the way to base.
	const keys = Object.keys(profile.spaceEnv ?? {});
	if (keys.length > 0) env.PI_SPACES_BASE_ENV = JSON.stringify(Object.fromEntries(keys.flatMap((key) => (plain[key] === undefined ? [] : [[key, plain[key]]]))));
	return { program, args: [...args, ...words], env };
}

/**
 * The start of one of Pi's package commands: as startFor, except base of a profile whose command switches through
 * --space (no commands, no {home}), which runs the command with no --space and the plain environment of the profile,
 * whose PI_CODING_AGENT_DIR is the base home. --space
 * is the extension's own option, and a base home that does not have it yet rejects it, so `install --every
 * npm:pi-spaces` could never install it there. Throws when the command has an unclosed quote.
 */
function packageStart(scope: Scope, name: string, words: string[]): Start {
	const { io, commands } = scope;
	if (name !== BASE || commands !== undefined || hasHomeCommand(io.env)) return startFor(scope, name, words);
	const { program, args } = setupCommand(io.env.PI_SPACES_COMMAND?.trim() || "pi", scope.profile.home, BASE, rootOf(scope, BASE));
	return { program, args: [...args, ...words], env: io.childEnv };
}

/** The root of a space of this scope: <spaces folder>/<name>; for base, the folder above the profile's home. */
function rootOf(scope: Scope, name: string): string {
	return name === BASE ? dirname(scope.profile.home) : join(scope.dir, name);
}

/**
 * Base started with `template` as it is ({home}, {space} and {name} are the profile's home, the folder above it and base), the words after it, no
 * --space, and the plain environment of the profile plus PI_SPACES_BASE_HOME, which marks base as opened by pi-spaces,
 * as `--space base` does: the extension shows 🪐 <profile>/base.
 */
function baseStart(scope: Scope, template: string, words: string[]): Start {
	const { io, profile } = scope;
	const { program, args } = setupCommand(template, profile.home, BASE, rootOf(scope, BASE));
	return { program, args: [...args, ...words], env: { ...(io.childEnv ?? io.env), PI_SPACES_BASE_HOME: profile.home } };
}

/**
 * When the first word is one of the profile's `homeless` words (a program's own command that takes no home, such as
 * `upgrade`), the command without its home part, then the words as they are, with no --space and the plain environment
 * of the profile: every word with {home} is dropped, with an option right before a bare {home} (`--home {home}`), and
 * {name} and {space} are still filled in. Otherwise undefined. Throws when the command has an unclosed quote.
 */
function homelessStart(scope: Scope, name: string, words: string[]): Start | undefined {
	const { io, profile } = scope;
	if (words.length === 0 || !profile.homeless?.includes(words[0])) return undefined;
	const kept: string[] = [];
	const root = rootOf(scope, name);
	for (const word of splitCommand(io.env.PI_SPACES_COMMAND ?? "")) {
		if (!word.includes("{home}")) kept.push(word.replaceAll("{space}", () => root).replaceAll("{name}", () => name));
		else if (word === "{home}" && kept.length > 1 && kept[kept.length - 1].startsWith("-")) kept.pop();
	}
	const [program = "pi", ...args] = kept;
	return { program, args: [...args, ...words], env: io.childEnv };
}

/**
 * The program and arguments of the setup command for one space: the template split like --command, with every
 * {home}, {space} and {name} in each word replaced by the space's agent home, its root and its name. An old flat space
 * has no root of its own, so without `spaceRoot` it is the home. Throws when it has an unclosed quote.
 */
export function setupCommand(template: string, home: string, name: string, spaceRoot: string = home): { program: string; args: string[] } {
	// Replacer functions, so a "$" in the folder or name is put in as written, never read as a pattern.
	const fill = (word: string) => word.replaceAll("{home}", () => home).replaceAll("{space}", () => spaceRoot).replaceAll("{name}", () => name);
	const [program = "", ...args] = splitCommand(template).map(fill);
	return { program, args };
}

/**
 * Splits a command into words on whitespace. Double or single quotes keep whitespace inside a word and are
 * removed. There are no backslash escapes, so a Windows path in quotes keeps its backslashes.
 */
export function splitCommand(text: string): string[] {
	const words: string[] = [];
	let word = "";
	// True from the first character or quote of a word, so "" alone is an empty word.
	let started = false;
	let quote: string | undefined;
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = undefined;
			else word += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += char;
			started = true;
		}
	}
	if (quote) throw new Error(`the command has an unclosed ${quote} quote`);
	if (started) words.push(word);
	return words;
}

const EXTENSION = "pi-spaces";

/**
 * The extension's declaration for a new space's settings.json: the one in the base home's settings.json
 * (the selected profile's home, else PI_SPACES_BASE_HOME, else PI_CODING_AGENT_DIR, else ~/.pi/agent),
 * else npm:pi-spaces.
 */
export function newSpaceDeclaration(env: Env, home: string, profileHome?: string): PackageDeclaration {
	const baseHome = profileHome || env.PI_SPACES_BASE_HOME || agentHome(env, home);
	let packageRoot: string;
	try {
		packageRoot = dirname(fileURLToPath(import.meta.resolve(`${EXTENSION}/package.json`)));
	} catch {
		packageRoot = "";
	}
	return findOwnDeclaration(baseHome, EXTENSION, packageRoot, `npm:${EXTENSION}`);
}

// The variables unwinding never rewrites: PWD and OLDPWD describe the working directory, the others are PI_SPACES_* state.
const KEPT_AS_IS = new Set(["PI_SPACES_DIR", "PI_SPACES_BASE_HOME", "PI_SPACES_BASE_ENV", "PWD", "OLDPWD"]);
const SPACE_VARIABLES = ["PI_SPACE", "PI_SPACE_HOME", "PI_SPACES_BASE_HOME", "PI_SPACES_BASE_ENV"];

/**
 * The environment of a plain terminal for `profile`, from the caller's: inside a space (PI_SPACES_BASE_HOME is set and
 * is not the current home) the space is unwound as the extension's relaunch does on the way back to base: every value
 * that is the space's folder or a path inside it (each entry of a list on its own) moves to the base home, and the
 * caller profile's spaceEnv variables get their base values from PI_SPACES_BASE_ENV (removed when it has none).
 * Then the variables of a space are removed and PI_CODING_AGENT_DIR is the profile's home.
 * This reimplements the small relaunchEnv step instead of exporting it: the core's exports are a public contract.
 */
function plainEnv(call: Call, profile: Profile): Env {
	const { config, io } = call;
	const { env } = io;
	const base = env.PI_SPACES_BASE_HOME;
	const current = agentHome(env, io.home);
	let next: Env = { ...env };
	if (base && !samePath(current, base)) {
		const from = resolve(current);
		const move = (part: string) => (part === from || part.startsWith(from + sep) ? resolve(base) + part.slice(from.length) : part);
		next = {};
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined) next[key] = KEPT_AS_IS.has(key) ? value : value.split(delimiter).map(move).join(delimiter);
		}
		let kept: Record<string, unknown> = {};
		try {
			kept = JSON.parse(env.PI_SPACES_BASE_ENV ?? "{}") ?? {};
		} catch {}
		for (const key of Object.keys(profileForHome(config, base, env, io.home)?.spaceEnv ?? {})) {
			delete next[key];
			const value = kept[key];
			if (typeof value === "string") next[key] = value;
		}
	}
	for (const key of SPACE_VARIABLES) delete next[key];
	next.PI_CODING_AGENT_DIR = profile.home;
	return next;
}

/** The agent home Pi uses from this shell: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
function agentHome(env: Env, home: string): string {
	return env.PI_CODING_AGENT_DIR ? env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, home) : join(home, ".pi", "agent");
}

export interface SpawnOptions {
	stdio: "inherit";
	/** The child's whole environment; the CLI always sets it (the caller's, with the PI_SPACES_* of the profile). */
	env?: Env;
}

export interface SpawnResult {
	status: number | null;
	error?: Error;
}

export interface CliIo {
	stdin: PickerTerminal["stdin"];
	stdout: PickerTerminal["stdout"];
	stderr: { write(text: string): unknown };
	env: Env;
	/** The environment for the started Pi; main sets it for every profile it runs (see scopeOf). */
	childEnv?: Env;
	home: string;
	/** The current folder, where a pinned space is looked for; default process.cwd(). */
	cwd?: string;
	spawn(program: string, args: string[], options: SpawnOptions): Promise<SpawnResult>;
	exit(code: number): void;
}

/**
 * The real child process: stdio inherited, the environment as the CLI gives it. cross-spawn is plain child_process.spawn
 * except on Windows, where it finds .cmd and .bat shims such as pi.cmd and escapes the arguments for them.
 */
export function spawnChild(program: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
	// Ctrl-C belongs to Pi while it runs; this process waits for it instead of dying first.
	const ignore = () => {};
	process.on("SIGINT", ignore);
	return new Promise<SpawnResult>((resolve) => {
		const child = crossSpawn(program, args, options);
		child.once("error", (error) => resolve({ status: null, error }));
		child.once("close", (status) => resolve({ status }));
	}).finally(() => process.off("SIGINT", ignore));
}

/** The CLI wired to a real process. */
export function processIo(proc: NodeJS.Process = process): CliIo {
	return {
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		env: proc.env,
		home: homedir(),
		cwd: proc.cwd(),
		spawn: spawnChild,
		exit: (code) => proc.exit(code),
	};
}

/** What one call settled before it looks at any profile: the caller's io, its options and the config file. */
interface Call {
	options: CallOptions;
	config: Config | undefined;
	/** The config file this call reads (absolute), whether or not it exists. */
	configFile: string;
	/** The caller's io, with its own environment. */
	io: CliIo;
}

/** One profile under this call: its folder, the io of the Pi it starts, and where its command and setup came from. */
interface Scope {
	profile: Profile;
	/** The caller's io with the environment of the started Pi (and of the setup command): see scopeOf. */
	io: CliIo;
	/** The spaces folder: --dir, else the profile's. */
	dir: string;
	commandSource: string;
	setupSource: string;
	/** The commands of a v2 profile; undefined for a v1 profile, and when --command replaced them for this call. */
	commands?: { base: string; space?: string };
}

/** What stands for "every space of a profile" after the slash of `<profile>/--every`. */
const EVERY = "--every";

/**
 * The profile `name` under this call's options: the command, spaces folder and setup are the option's, else the
 * profile's; the caller's PI_SPACES_COMMAND, PI_SPACES_DIR and PI_SPACES_SETUP are never read. The started Pi gets
 * the caller's environment with those three set to what was settled (the command and the setup removed when there
 * is none), and PI_SPACES_CONFIG when --config was given. io.env stays the caller's (the protections of remove and
 * rename read the Pi the caller is in); io.childEnv, what Pi and the setup command start from, is the caller's
 * environment unwound to a plain terminal of the profile (see plainEnv). Throws a ConfigError for an unknown profile.
 */
function scopeOf(call: Call, name: string): Scope {
	const { options, config, configFile, io: caller } = call;
	const profile = profileByName(config, name, caller.env, caller.home);
	// Absolute: a relative one is relative to where the command runs.
	const dir = options.dir !== undefined ? resolve(options.dir) : profile.dir;
	const command = options.command ?? profile.command;
	const setup = options.setup ?? profile.setup;
	const handed = (from: Env): Env => {
		const env: Env = { ...from, PI_SPACES_DIR: dir };
		if (command !== undefined) env.PI_SPACES_COMMAND = command;
		else delete env.PI_SPACES_COMMAND;
		if (setup !== undefined) env.PI_SPACES_SETUP = setup;
		else delete env.PI_SPACES_SETUP;
		if (options.config !== undefined) env.PI_SPACES_CONFIG = configFile;
		return env;
	};
	return {
		profile,
		io: { ...caller, env: handed(caller.env), childEnv: handed(plainEnv(call, profile)) },
		dir,
		commandSource: options.command !== undefined ? "--command" : `profile "${name}" command`,
		setupSource: options.setup !== undefined ? "--setup" : `profile "${name}" setup`,
		commands: options.command !== undefined ? undefined : profile.commands,
	};
}

/**
 * The profile names in the order pi-space shows and runs them everywhere (list, the picker, --every, completion
 * and messages): the built-in pi first, then the others in alphabetical order, whatever their order in the file.
 */
function orderedProfileNames(config: Config | undefined): string[] {
	return profileNames(config).sort((a, b) => (a === "pi" ? -1 : b === "pi" ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

/** The scopes of every profile, in the order of orderedProfileNames. */
function allScopes(call: Call): Scope[] {
	return orderedProfileNames(call.config).map((name) => scopeOf(call, name));
}

/**
 * Splits `<profile>/<name>` at the first "/". A name without its profile exits 2 with the form to use, and gives
 * undefined, so the caller returns.
 */
function qualify(text: string, call: Call): { profile: string; name: string } | undefined {
	const slash = text.indexOf("/");
	if (slash > 0) return { profile: text.slice(0, slash), name: text.slice(slash + 1) };
	call.io.stderr.write(`pi-space: Name the space with its profile, as <profile>/${slash === 0 ? text.slice(1) : text} (profiles: ${orderedProfileNames(call.config).join(", ")}).\n`);
	call.io.exit(2);
	return undefined;
}

/** Whether a command runs in more than one profile: the picker, `list` alone and --every alone. */
function spansProfiles(command: CliCommand): boolean {
	switch (command.kind) {
		case "picker":
		case "pick":
		case "list":
			return true;
		case "packages":
		case "setup":
		case "migrate":
			return "every" in command.target;
		case "pin":
			return command.name === undefined;
		default:
			return false;
	}
}

export async function main(argv: string[], io: CliIo): Promise<void> {
	const command = parseCli(argv);
	switch (command.kind) {
		case "help":
			io.stdout.write(USAGE);
			return io.exit(0);
		case "command-help":
			if (Object.hasOwn(COMMANDS, command.command)) {
				io.stdout.write(commandHelp(command.command));
				return io.exit(0);
			}
			io.stderr.write(`pi-space: No help for "${command.command}"; commands: ${Object.keys(COMMANDS).join(", ")}.\n`);
			return io.exit(2);
		case "version":
			io.stdout.write(`${VERSION}\n`);
			return io.exit(0);
		case "unknown-option":
			io.stderr.write(`pi-space: Unknown option "${command.option}".\n${USAGE}`);
			return io.exit(2);
		case "replaced":
			io.stderr.write(`pi-space: ${command.option} was replaced by: ${command.instead}\n`);
			return io.exit(2);
		case "usage":
			io.stderr.write(USAGE);
			return io.exit(2);
		case "completion":
			return printCompletion(command.shell, io);
		case "complete":
			return complete(command.words, io);
		case "init":
			return writeInit(command.config !== undefined ? resolve(command.config) : configPath(io.env, io.home), io);
	}
	// --config is read as given: only the lookup can shadow a config.json, so only it can warn.
	const located = command.config !== undefined ? { path: resolve(command.config) } : findConfigFile(io.env, io.home);
	const configFile = located.path;
	const ignored = ignoredWarning(located);
	if (ignored !== undefined) io.stderr.write(`pi-space: ${ignored}\n`);
	try {
		const config = loadConfig(configFile);
		if (config?.default !== undefined) {
			io.stderr.write(`pi-space: ${configFile}: "default" is no longer used; name each space with its profile (<profile>/<name>) and remove "default" from the file.\n`);
		}
		const call: Call = { options: command, config, configFile, io };
		// A bare pi-space where a space is pinned starts that one space, so it does not span profiles.
		const pinned = command.kind === "picker" ? findPin(currentFolder(io), io.home) : undefined;
		if (spansProfiles(command) && pinned === undefined && (command.command !== undefined || command.dir !== undefined)) {
			io.stderr.write("pi-space: --command and --dir apply to one profile; name it: <profile>/<name> or <profile>/--every.\n");
			return io.exit(2);
		}
		switch (command.kind) {
			case "list":
				return listProfiles(call);
			case "packages":
				return await runPackages(command.verb, command.target, command.args, call);
			case "new": {
				const ref = qualify(command.name, call);
				return ref && (await create(ref.name, scopeOf(call, ref.profile), command.extension));
			}
			case "setup":
				return await runSetup(command.target, call);
			case "migrate":
				return runMigrate(command.target, call);
			case "rename": {
				const ref = qualify(command.from, call);
				if (!ref) return;
				// The new name is bare or carries the same profile: a space never changes profile.
				const slash = command.to.indexOf("/");
				if (slash >= 0 && command.to.slice(0, slash) !== ref.profile) {
					io.stderr.write(`pi-space: A space keeps its profile: rename ${ref.profile}/${ref.name} to ${ref.profile}/<name>.\n`);
					return io.exit(2);
				}
				return rename(ref.name, slash >= 0 ? command.to.slice(slash + 1) : command.to, scopeOf(call, ref.profile));
			}
			case "remove": {
				const ref = qualify(command.name, call);
				return ref && (await remove(ref.name, command.yes, command.backup, scopeOf(call, ref.profile)));
			}
			case "launch": {
				const ref = qualify(command.name, call);
				return ref && (await launch(ref.name, command.args, scopeOf(call, ref.profile)));
			}
			case "picker":
				return pinned === undefined ? await pick(call) : await launchPinned(pinned, call);
			case "pick":
				return await pick(call);
			case "pin":
				if (command.name !== undefined) return pinSpace(command.name, call);
				return command.show || !io.stdin.isTTY ? showPin(call) : await pinPicker(call);
			case "unpin":
				return unpin(call);
		}
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		io.stderr.write(`pi-space: ${error.message}\n`);
		return io.exit(2);
	}
}

/** The TOML `pi-space init` writes: comments that show the built-in pi profile and another one, then an empty v2 config. */
export function initConfigToml(piHome: string, piDir: string): string {
	// JSON.stringify of a path is a valid TOML basic string: TOML has every escape it writes (\\, \", \n and the like, \uXXXX).
	return `# pi-spaces config: https://github.com/jals1212/pi-spaces#profiles
#
# The built-in profile "pi" is always there, set up like this; add a
# [profiles.pi] table to change it:
#
#   [profiles.pi]
#   home = ${JSON.stringify(piHome)}
#   dir = ${JSON.stringify(piDir)}
#   commands = { base = "pi", space = "pi --space {name}" }
#
# A profile for another program that runs Pi, for example:
#
#   [profiles.ml]
#   home = "~/.my-launcher/agent"
#   spaceEnv = { MY_LAUNCHER_CONFIG_HOME = "{home}/config" }
#
#   [profiles.ml.commands]
#   base = "my-launcher"
#   space = "my-launcher --home {home}"
#   setup = "my-launcher --home {home} setup"

schema = ${JSON.stringify(SCHEMA)}
`;
}

/** The JSON text of the config file `pi-space init` writes: comments that show the built-in pi profile and another one, then an empty v2 config. */
export function initConfigText(piHome: string, piDir: string): string {
	return `// pi-spaces config: https://github.com/jals1212/pi-spaces#profiles
//
// The built-in profile "pi" is always there, set up like this; add "pi" under
// "profiles" to change it:
//
//   "pi": {
//     "home": ${JSON.stringify(piHome)},
//     "dir": ${JSON.stringify(piDir)},
//     "commands": { "base": "pi", "space": "pi --space {name}" }
//   }
//
// A profile for another program that runs Pi, for example:
//
//   "ml": {
//     "home": "~/.my-launcher/agent",
//     "commands": {
//       "base": "my-launcher",
//       "space": "my-launcher --home {home}",
//       "setup": "my-launcher --home {home} setup"
//     },
//     "spaceEnv": { "MY_LAUNCHER_CONFIG_HOME": "{home}/config" }
//   }
{
  "schema": ${JSON.stringify(SCHEMA)},
  "profiles": {}
}
`;
}

/**
 * `pi-space init`: writes the config file, with its folders, unless it exists (exit 1); an existing file is never read.
 * A file that cannot be written (a folder that cannot be made, no permission) exits 1 with the reason.
 */
function writeInit(file: string, io: CliIo): void {
	const refuseExisting = () => {
		io.stderr.write(`pi-space: ${file} already exists; edit it, or remove it to write a new one.\n`);
		return io.exit(1);
	};
	if (existsSync(file)) return refuseExisting();
	const pi = profileByName(undefined, "pi", io.env, io.home);
	try {
		mkdirSync(dirname(file), { recursive: true });
		// wx: a file that appeared since the check above is never overwritten.
		const text = isToml(file) ? initConfigToml(pi.home, pi.dir) : initConfigText(pi.home, pi.dir);
		writeFileSync(file, text, { flag: "wx" });
	} catch (error) {
		const { code, path, message } = error as NodeJS.ErrnoException;
		// That file gets the same answer as one that was there before; anything else names the file and the reason.
		if (code === "EEXIST" && path === file) return refuseExisting();
		io.stderr.write(`pi-space: cannot write ${file}: ${message}\n`);
		return io.exit(1);
	}
	io.stdout.write(`Wrote ${file}.\n`);
	return io.exit(0);
}

/** `pi-space list`: every profile, its folder, then its base and spaces as `<profile>/<name>`. */
function listProfiles(call: Call): void {
	const lines: string[] = [];
	let any = false;
	for (const { profile, dir } of allScopes(call)) {
		const spaces = listSpaces(dir);
		any ||= spaces.length > 0;
		lines.push(`Spaces of ${profile.name} in ${dir}:`, `  ${profile.name}/${BASE}`, ...spaces.map((name) => `  ${profile.name}/${name}`));
	}
	if (!any) lines.push("No spaces yet. Create one with pi-space new <profile>/<name>.");
	call.io.stdout.write(`${lines.join("\n")}\n`);
	return call.io.exit(0);
}

const SHELLS = ["zsh", "powershell"];

/** `pi-space completion <shell>`: the script on stdout, or exit 2 for a shell it does not know. */
function printCompletion(shell: string | undefined, io: CliIo): void {
	if (shell === undefined) {
		io.stderr.write(`pi-space: Name a shell: pi-space completion zsh (supported shells: ${SHELLS.join(", ")}).\n`);
		return io.exit(2);
	}
	if (shell !== "zsh" && shell !== "powershell") {
		io.stderr.write(`pi-space: Unsupported shell "${shell}"; supported shells: ${SHELLS.join(", ")}.\n`);
		return io.exit(2);
	}
	io.stdout.write(shell === "zsh" ? ZSH_COMPLETION : POWERSHELL_COMPLETION);
	return io.exit(0);
}

/** What `__complete` prints when the shell should complete a file or folder itself. */
const FILES = "__files__";

/**
 * The zsh script: it asks `pi-space __complete <the words before the cursor>` for candidates, one per line as
 * `<group>\t<value>\t<description>`, and hands each group to _describe (a ":" in a value is escaped for it).
 * The `__files__` marker falls back to the shell's file completion. An abbreviation or alias has already
 * expanded by then, so `my-space <TAB>` completes the words of what it stands for.
 * The options show only for a word that starts with "-", so `pi-space new <TAB>` never inserts a lone --help.
 */
const ZSH_COMPLETION = [
	"#compdef pi-space",
	"# zsh completion for pi-space. Load it from .zshrc with: source <(pi-space completion zsh)",
	"_pi_space() {",
	"  local -a lines cmds spaces targets shells opts",
	"  local line group value text ret=1",
	'  lines=("${(@f)$(command "${words[1]}" __complete "${(@)words[2,CURRENT-1]}" 2>/dev/null)}")',
	`  if [[ "\${lines[1]}" == ${FILES} ]]; then`,
	"    _files",
	"    return",
	"  fi",
	'  for line in "${(@)lines}"; do',
	'    [[ -n "$line" ]] || continue',
	"    group=${line%%$'\\t'*}",
	"    line=${line#*$'\\t'}",
	"    value=${line%%$'\\t'*}",
	"    text=${line#*$'\\t'}",
	"    [[ \"$text\" == \"$line\" ]] && text=",
	"    value=${value//:/\\\\:}",
	'    case "$group" in',
	'      command) cmds+=("$value:$text") ;;',
	'      space) spaces+=("$value:$text") ;;',
	'      target) targets+=("$value:$text") ;;',
	'      shell) shells+=("$value:$text") ;;',
	'      option) [[ "$PREFIX" == -* ]] && opts+=("$value:$text") ;;',
	"    esac",
	"  done",
	// The spaces come first, as an unsorted group in pi-space's own (alphabetical) order; with the `sort false` style
	// below, zsh and fzf-tab show every group in the order it is added here.
	"  (( $#spaces )) && _describe -t spaces 'spaces' spaces -V pi-space-spaces && ret=0",
	"  (( $#cmds )) && _describe -t commands 'commands' cmds && ret=0",
	"  (( $#targets )) && _describe -t targets 'targets' targets && ret=0",
	"  (( $#shells )) && _describe -t shells 'shells' shells && ret=0",
	"  (( $#opts )) && _describe -t options 'options' opts && ret=0",
	"  return ret",
	"}",
	"compdef _pi_space pi-space",
	// pi-space already gives its candidates in order (spaces first, alphabetical); zsh and fzf-tab must not resort them.
	"zstyle ':completion:*:pi-space:*' sort false",
	// Each group apart under its own header ([spaces], [commands], [options]...), so the spaces stand apart from the
	// rest; fzf-tab shows groups only when the descriptions have a format, and ignores escape sequences in it.
	"zstyle ':completion:*:pi-space:*' group-name ''",
	"zstyle ':completion:*:pi-space:*:descriptions' format '[%d]'",
	"",
].join("\n");

/**
 * The PowerShell script (PowerShell 7 and Windows PowerShell 5.1): the same idea as the zsh one. It asks
 * `pi-space __complete <the words before the cursor>` and turns each line into a completion result, in the order
 * received, so PowerShell shows one list in pi-space's order (the description is the tooltip; there are no group headers).
 * The `__files__` marker returns nothing, so PowerShell falls back to its own path completion.
 * The options show only for a word that starts with "-", as in zsh.
 */
const POWERSHELL_COMPLETION = [
	"# PowerShell completion for pi-space. Load it from $PROFILE with: pi-space completion powershell | Out-String | Invoke-Expression",
	"# To pick from a menu on Tab, add this to $PROFILE too: Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete",
	"Register-ArgumentCompleter -Native -CommandName pi-space -ScriptBlock {",
	"  param($wordToComplete, $commandAst, $cursorPosition)",
	"  $wordToComplete = [string]$wordToComplete",
	"  $text = { param($element) if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $element.Value } else { $element.Extent.Text } }",
	// The first word is the command the user typed (pi-space, or a path to it); fall back to pi-space when it has no text.
	"  $elements = @($commandAst.CommandElements)",
	"  $exe = $null",
	"  if ($elements.Count -gt 0) { $exe = & $text $elements[0] }",
	"  if (-not $exe) { $exe = 'pi-space' }",
	// The words before the cursor end before it. The word being completed ends at the cursor, so it is left out.
	"  $words = @()",
	"  foreach ($element in @($elements | Select-Object -Skip 1)) {",
	"    if ($element.Extent.EndOffset -lt $cursorPosition) { $words += (& $text $element) }",
	"  }",
	"  $lines = @()",
	// Returning nothing makes PowerShell complete the folder's files; only the marker asks for them. Otherwise, with no
	// candidate, a lone "" stops that: PowerShell 7.7 reads it as no completion, and before 7.7 it makes the completion
	// fail, which PSReadLine ignores, so Tab does nothing.
	"  try { $lines = @(& $exe __complete @words 2>$null) } catch { return '' }",
	`  if ($lines.Count -gt 0 -and $lines[0] -eq '${FILES}') { return }`,
	"  $found = $false",
	"  $pattern = [WildcardPattern]::Escape($wordToComplete) + '*'",
	"  foreach ($line in $lines) {",
	"    if (-not $line) { continue }",
	"    $parts = ([string]$line).Split([char]9)",
	"    $group = $parts[0]",
	"    $value = if ($parts.Count -gt 1) { $parts[1] } else { '' }",
	"    $tip = if ($parts.Count -gt 2) { $parts[2] } else { '' }",
	"    if (-not $value) { continue }",
	"    if ($group -eq 'option' -and $wordToComplete -notlike '-*') { continue }",
	"    if ($value -notlike $pattern) { continue }",
	"    if (-not $tip) { $tip = $value }",
	// A value with a space or a special character is quoted, so the line stays one word.
	"    $completion = if ($value -match '[\\s\\x27\\x22`$&;|<>(){}\\[\\],@#]') { \"'\" + $value.Replace(\"'\", \"''\") + \"'\" } else { $value }",
	"    [System.Management.Automation.CompletionResult]::new($completion, $value, 'ParameterValue', $tip)",
	"    $found = $true",
	"  }",
	"  if (-not $found) { '' }",
	"}",
	"",
].join("\n");

/** The groups of a `__complete` line; `target` is --every, which stands in for a space name. */
type Group = "command" | "space" | "target" | "shell" | "option";

/** One `__complete` line; the description never holds a tab or a newline. */
function candidate(group: Group, value: string, text: string): string {
	return `${group}\t${value}\t${text.replace(/\s+/g, " ")}`;
}

/**
 * The hidden `__complete <words before the cursor>`: one candidate per line, honoring the call options already
 * typed. It never fails loudly: whatever goes wrong, it prints nothing and exits 0.
 */
function complete(words: string[], io: CliIo): void {
	let lines: string[] = [];
	try {
		lines = candidates(words, io);
	} catch {
		lines = [];
	}
	if (lines.length > 0) io.stdout.write(`${lines.join("\n")}\n`);
	return io.exit(0);
}

/** The commands with their summary, in alphabetical order; in first place `completion` is left out (it still works typed in full), after --help it is not. */
function commandCandidates(withCompletion: boolean): string[] {
	return Object.entries(COMMANDS)
		.filter(([name]) => withCompletion || name !== "completion")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, help]) => candidate("command", name, help.summary));
}

/** The call options not typed yet, then --help and --version when nothing was typed before. */
function firstOptions(call: CallOptions, alone: boolean): string[] {
	const calls = Object.entries(CALL_OPTIONS)
		.filter(([, key]) => call[key] === undefined)
		.map(([flag, key]) => candidate("option", flag, CALL_HELP[key][1]));
	const general = alone ? GENERAL_OPTIONS.map(([flag, text]) => candidate("option", flag, text)) : [];
	return [...calls, ...general];
}

/** A profile and the names in its spaces folder, as `__complete` offers them. */
interface CompletionProfile {
	name: string;
	/** What a space of the profile starts: its command, or pi. */
	command: string;
	/** What its base starts: commands.base of a v2 profile, else the same as command. */
	base: string;
	spaces: string[];
}

/** `<profile>/base`, if asked, and `<profile>/<name>`: pi's first, then the custom profiles', each alphabetical. */
function spaceCandidates(profiles: CompletionProfile[], withBase: boolean): string[] {
	const spaces = profiles.flatMap((profile) => [
		...(withBase ? [{ builtIn: profile.name === "pi", value: `${profile.name}/${BASE}`, text: `base home of ${profile.name} (${profile.base})` }] : []),
		...profile.spaces.map((name) => ({ builtIn: profile.name === "pi", value: `${profile.name}/${name}`, text: `space of ${profile.name} (${profile.command})` })),
	]);
	// The built-in pi first; then alphabetical by the whole name, whatever the order of the profiles in the file.
	spaces.sort((a, b) => (a.builtIn !== b.builtIn ? (a.builtIn ? -1 : 1) : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
	return spaces.map(({ value, text }) => candidate("space", value, text));
}

/** The `--every` targets: one for every profile, then one `<profile>/--every` for each. */
function everyCandidates(profiles: CompletionProfile[], every: string, each: (profile: string) => string): string[] {
	return [candidate("target", "--every", every), ...profiles.map((profile) => candidate("target", `${profile.name}/--every`, each(profile.name)))];
}

/** What follows a command word: its target, its own options and --help. */
function commandArguments(command: string, profiles: CompletionProfile[]): string[] {
	const options = [...COMMANDS[command].options, HELP_OPTION].map((option) => candidate("option", option.flag, option.text));
	switch (command) {
		case "remove":
		case "rename":
			return [...spaceCandidates(profiles, false), ...options];
		case "setup":
			return [...spaceCandidates(profiles, false), ...everyCandidates(profiles, "every space of every profile with a setup command", (name) => `every space of ${name}`), ...options];
		case "migrate":
			return [...spaceCandidates(profiles, false), ...everyCandidates(profiles, "every space of every profile", (name) => `every space of ${name}`), ...options];
		case "list":
		case "update":
		case "install":
		case "uninstall":
			return [...spaceCandidates(profiles, true), ...everyCandidates(profiles, "every profile, base first", (name) => `base and every space of ${name}`), ...options];
		case "pin":
			return [...spaceCandidates(profiles, true), ...options];
		case "completion":
			return [...SHELLS.map((shell) => candidate("shell", shell, `the ${shell} completion script`)), ...options];
		default:
			return options;
	}
}

function candidates(words: string[], io: CliIo): string[] {
	const call: CallOptions = {};
	let index = 0;
	while (Object.hasOwn(CALL_OPTIONS, words[index] ?? "")) {
		const option = words[index] as keyof typeof CALL_OPTIONS;
		// The option is the last word: the cursor is on its value.
		if (index + 1 >= words.length) return optionValues(option);
		call[CALL_OPTIONS[option]] = words[index + 1];
		index += 2;
	}
	const configFile = call.config !== undefined ? resolve(call.config) : configPath(io.env, io.home);
	const config = loadConfig(configFile);
	// A --dir typed before the cursor is read as the spaces folder of every profile.
	const dirOverride = call.dir === undefined ? undefined : resolve(call.dir);
	const profiles = orderedProfileNames(config).map((name): CompletionProfile => {
		const profile = profileByName(config, name, io.env, io.home);
		return { name, command: profile.command ?? "pi", base: profile.commands?.base ?? profile.command ?? "pi", spaces: listSpaces(dirOverride ?? profile.dir) };
	});
	const rest = words.slice(index);
	if (rest.length === 0) return [...spaceCandidates(profiles, true), ...commandCandidates(false), ...firstOptions(call, index === 0)];
	if (rest.length > 1) return [];
	if (isHelpFlag(rest[0])) return commandCandidates(true);
	if (!Object.hasOwn(COMMANDS, rest[0])) return [];
	return commandArguments(rest[0], profiles);
}

/** The candidates for the value of a call option: the shell's files for a path, nothing for a command. */
function optionValues(option: keyof typeof CALL_OPTIONS): string[] {
	return option === "--config" || option === "--dir" ? [FILES] : [];
}

/** Prints the reason and returns false when the setup command has an unclosed quote. */
function checkSetup(io: CliIo, source: string): boolean {
	try {
		splitCommand(io.env.PI_SPACES_SETUP ?? "");
		return true;
	} catch (error) {
		io.stderr.write(`pi-space: ${source}: ${(error as Error).message}.\n`);
		return false;
	}
}

/** Runs a setup command in a space, as that space's agent home (with the profile's spaceEnv), and returns its exit status. */
function spawnSetup(setup: { program: string; args: string[] }, name: string, home: string, root: string, io: CliIo, profile: Profile): Promise<number> {
	// The profile's spaceEnv, for this space, then the three variables of the space, which a profile cannot set.
	const spaceEnv = spaceEnvFor(profile, home, name, root);
	return spawnPi(setup.program, setup.args, io, { ...(io.childEnv ?? io.env), ...spaceEnv, PI_CODING_AGENT_DIR: home, PI_SPACE: name, PI_SPACE_HOME: home });
}

/** The setup command for one space, from PI_SPACES_SETUP of this profile's io; checkSetup has accepted it. */
function setupFor(name: string, home: string, root: string, io: CliIo): { program: string; args: string[] } {
	return setupCommand(io.env.PI_SPACES_SETUP ?? "", home, name, root);
}

/**
 * Creates a space. `extension` says whether its settings.json declares the extension; undefined asks in a terminal
 * ([Y/n]: only a clear no leaves it out) and declares it without one.
 */
async function create(name: string, scope: Scope, extension?: boolean): Promise<void> {
	const { io, dir, profile } = scope;
	const withSetup = hasSetupCommand(io.env);
	// A bad setup command is reported before anything is created.
	if (withSetup && !checkSetup(io, scope.setupSource)) return io.exit(2);
	try {
		const path = createSpace(dir, name, newSpaceDeclaration(io.env, io.home, profile.home));
		io.stdout.write(`Created space "${name}" at ${path}.\n`);
		let declare = extension ?? true;
		if (extension === undefined && io.stdin.isTTY) {
			const reader = lineReader(io.stdin);
			try {
				io.stdout.write(`Declare the Pi extension pi-spaces in "${name}"? Pi installs it there and gets /space and the status line; pi-space does not need it. [Y/n] `);
				const answer = (await reader.next())?.trim().toLowerCase();
				declare = answer !== "n" && answer !== "no";
			} finally {
				reader.close();
			}
		}
		if (!declare) {
			writeFileSync(join(spaceHome(path), "settings.json"), "{}\n");
			io.stdout.write(`It does not declare the extension; add it later with: pi-space install ${profile.name}/${name} npm:pi-spaces\n`);
		}
		if (withSetup) {
			// A new space is rooted: the setup runs in its agent home.
			const home = spaceHome(path);
			const setup = setupFor(name, home, path, io);
			io.stdout.write(`Setting it up: ${[setup.program, ...setup.args].join(" ")}\n`);
			const status = await spawnSetup(setup, name, home, path, io, profile);
			if (status !== 0) {
				io.stderr.write(`pi-space: Setup failed in space "${name}" (exit status ${status}); the space is kept. Run it again with: pi-space setup ${profile.name}/${name}\n`);
				return io.exit(status);
			}
		}
		io.stdout.write(`Start Pi in it with: pi-space ${profile.name}/${name}\n`);
		return io.exit(0);
	} catch (error) {
		// A SpaceError is a rule (a bad or taken name); anything else is the filesystem, such as no permission.
		io.stderr.write(`pi-space: ${error instanceof SpaceError ? error.message : `could not create space "${name}": ${(error as Error).message}`}\n`);
		return io.exit(1);
	}
}

/** The base homes a space must not be: the one Pi started with, and the profile's. */
function protectedHomes(io: CliIo, profile: Profile): string[] {
	return [io.env.PI_SPACES_BASE_HOME, profile.home].filter((home): home is string => Boolean(home));
}

/** Renames a space after the same checks as remove: not base, not the active space, not one that holds the base home. */
function rename(from: string, to: string, scope: Scope): void {
	const { io, dir, profile } = scope;
	try {
		const protect = protectedHomes(io, profile);
		renameSpace(dir, from, to, agentHome(io.env, io.home), protect, io.home);
		io.stdout.write(`Renamed space "${from}" to "${to}".\n`);
		return io.exit(0);
	} catch (error) {
		io.stderr.write(`pi-space: ${error instanceof SpaceError ? error.message : `could not rename space "${from}": ${(error as Error).message}`}\n`);
		return io.exit(1);
	}
}

/**
 * Without --yes it asks to remove ([y/N]), then, without --no-backup, whether to keep a backup ([Y/n]).
 * With --yes it asks nothing and keeps a backup unless --no-backup.
 */
async function remove(name: string, yes: boolean, backup: boolean, scope: Scope): Promise<void> {
	const { io, dir, profile } = scope;
	const current = agentHome(io.env, io.home);
	const protect = protectedHomes(io, profile);
	let reader: LineReader | undefined;
	try {
		// Fail before asking when the space cannot be removed anyway.
		const path = checkRemovable(dir, name, current, protect, io.home);
		let keep = backup;
		if (!yes) {
			if (!io.stdin.isTTY) throw new SpaceError(`Removing a space needs confirmation; run pi-space remove ${profile.name}/${name} --yes.`);
			// One reader for every question, so an answer typed ahead is not lost between them.
			reader = lineReader(io.stdin);
			io.stdout.write(`Remove space "${name}"? This deletes ${path} and everything in it: sign-ins, packages, settings and sessions. [y/N] `);
			if (!isYes(await reader.next())) {
				io.stdout.write(`Kept space "${name}".\n`);
				return io.exit(0);
			}
			if (backup) {
				io.stdout.write(`Keep a backup of "${name}" in ${join(dir, BACKUPS)}? [Y/n] `);
				// Only a clear no skips the backup: Enter or the end of input keep one.
				const answer = (await reader.next())?.trim().toLowerCase();
				keep = answer !== "n" && answer !== "no";
			}
		}
		if (keep) {
			const saved = backupSpace(dir, name, current, protect, io.home);
			io.stdout.write(`Removed space "${name}"; its backup is ${saved}.\n`);
		} else {
			removeSpace(dir, name, current, protect, io.home);
			io.stdout.write(`Removed space "${name}".\n`);
		}
		return io.exit(0);
	} catch (error) {
		io.stderr.write(`pi-space: ${error instanceof SpaceError ? error.message : `could not remove space "${name}": ${(error as Error).message}`}\n`);
		return io.exit(1);
	} finally {
		reader?.close();
	}
}

function isYes(answer: string | undefined): boolean {
	const word = answer?.trim().toLowerCase();
	return word === "y" || word === "yes";
}

interface LineReader {
	/** The next line, or undefined at end of input. */
	next(): Promise<string | undefined>;
	close(): void;
}

/** Reads lines one at a time from one readline interface, keeping lines that arrive before they are asked for. */
function lineReader(input: NodeJS.ReadableStream): LineReader {
	const rl = createInterface({ input });
	const lines: string[] = [];
	const waiting: ((line: string | undefined) => void)[] = [];
	let ended = false;
	rl.on("line", (line) => {
		const resolve = waiting.shift();
		if (resolve) resolve(line);
		else lines.push(line);
	});
	rl.once("close", () => {
		ended = true;
		for (const resolve of waiting.splice(0)) resolve(undefined);
	});
	return {
		next: () => {
			if (lines.length > 0) return Promise.resolve(lines.shift());
			if (ended) return Promise.resolve(undefined);
			return new Promise((resolve) => waiting.push(resolve));
		},
		close: () => rl.close(),
	};
}

/** Prints the reason and returns false when `name` is not base or an existing space. */
function checkSpace(name: string, dir: string, io: CliIo): boolean {
	if (name === BASE) return true;
	const invalid = validateName(name);
	if (invalid) {
		io.stderr.write(`pi-space: ${invalid}\n`);
		return false;
	}
	if (!listSpaces(dir).includes(name)) {
		io.stderr.write(`pi-space: Space "${name}" does not exist.\n`);
		return false;
	}
	return true;
}

/**
 * Runs a program with inherited stdio and returns its exit status; 1, with the reason printed, when it cannot start.
 * `env` is the child's whole environment; undefined lets it inherit this process's. Pi gets io.childEnv.
 */
async function spawnPi(program: string, programArgs: string[], io: CliIo, env: Env | undefined): Promise<number> {
	const options: SpawnOptions = { stdio: "inherit" };
	if (env) options.env = env;
	const result = await io.spawn(program, programArgs, options);
	if (result.error) {
		io.stderr.write(`pi-space: could not start ${program}: ${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

async function launch(name: string, args: string[], scope: Scope): Promise<void> {
	const { io } = scope;
	if (!checkSpace(name, scope.dir, io)) return io.exit(1);
	let launched: ReturnType<typeof startFor>;
	try {
		launched = homelessStart(scope, name, args) ?? startFor(scope, name, promptArgs(args));
	} catch (error) {
		io.stderr.write(`pi-space: ${scope.commandSource}: ${(error as Error).message}.\n`);
		return io.exit(2);
	}
	io.exit(await spawnPi(launched.program, launched.args, io, launched.env));
}

/**
 * Runs one of Pi's package commands in a space, in base and then every space of a profile (`<profile>/--every`),
 * or in every profile (`--every`), through the same Pi (`--space <name> <verb> [args...]`): the extension relaunches
 * it in that home, so the home is never set here. Base runs the verb with no --space, in its home (packageStart). With --every each run gets a `== <profile>/<name>` header, one
 * failure does not stop the rest, and the status is 1 if any failed.
 */
async function runPackages(verb: PackageVerb, target: PackageTarget, args: string[], call: Call): Promise<void> {
	const { io } = call;
	let scopes: Scope[];
	if ("every" in target) {
		scopes = allScopes(call);
	} else {
		const ref = qualify(target.name, call);
		if (!ref) return;
		const scope = scopeOf(call, ref.profile);
		if (ref.name !== EVERY) {
			if (!checkSpace(ref.name, scope.dir, io)) return io.exit(1);
			let launched: ReturnType<typeof startFor>;
			try {
				launched = packageStart(scope, ref.name, [verb, ...args]);
			} catch (error) {
				io.stderr.write(`pi-space: ${scope.commandSource}: ${(error as Error).message}.\n`);
				return io.exit(2);
			}
			return io.exit(await spawnPi(launched.program, launched.args, scope.io, launched.env));
		}
		scopes = [scope];
	}
	// Every command is checked before the first one runs, so a bad one is reported once, before any header.
	for (const scope of scopes) {
		try {
			packageStart(scope, BASE, []);
		} catch (error) {
			io.stderr.write(`pi-space: ${scope.commandSource}: ${(error as Error).message}.\n`);
			return io.exit(2);
		}
	}
	const failed: string[] = [];
	for (const scope of scopes) {
		for (const name of [BASE, ...listSpaces(scope.dir)]) {
			const launched = packageStart(scope, name, [verb, ...args]);
			io.stdout.write(`== ${scope.profile.name}/${name}\n`);
			if ((await spawnPi(launched.program, launched.args, scope.io, launched.env)) !== 0) failed.push(`${scope.profile.name}/${name}`);
		}
	}
	if (failed.length > 0) {
		io.stderr.write(`pi-space: ${verb} failed in: ${failed.join(", ")}\n`);
		return io.exit(1);
	}
	io.exit(0);
}

/**
 * Runs the setup command of a profile in base, then in each of `names`, with a `== <profile>/<name>` header; the
 * failures are added to `failed`.
 */
async function setupEach(scope: Scope, names: string[], failed: string[]): Promise<void> {
	for (const name of [BASE, ...names]) {
		scope.io.stdout.write(`== ${scope.profile.name}/${name}\n`);
		if ((await setupIn(scope, name)) !== 0) failed.push(`${scope.profile.name}/${name}`);
	}
}

/**
 * Runs the setup command of a profile in one of its spaces, or in base: there {home} is the profile's home, {space}
 * the folder above it and {name} base, with the plain environment of the profile (its PI_CODING_AGENT_DIR is that
 * home, and there is no PI_SPACE). Returns its exit status.
 */
function setupIn(scope: Scope, name: string): Promise<number> {
	const { io, profile } = scope;
	const root = rootOf(scope, name);
	if (name === BASE) {
		const setup = setupFor(BASE, profile.home, root, io);
		return spawnPi(setup.program, setup.args, io, io.childEnv ?? io.env);
	}
	const home = spaceHome(root);
	return spawnSetup(setupFor(name, home, root, io), name, home, root, io, profile);
}

/**
 * Runs the setup command in a space or in base, in base and then every space of a profile (`<profile>/--every`), or
 * in base and the spaces of every profile that has a setup command (`--every`; pi has none by default). With --every
 * each run gets a `== <profile>/<name>` header, one failure does not stop the rest, and the status is 1 if any failed.
 */
async function runSetup(target: PackageTarget, call: Call): Promise<void> {
	const { io } = call;
	const noSetup = (name: string) => `pi-space: Profile "${name}" has no setup command; give it a "setup" in the config file, or give --setup <cmd>.\n`;
	if ("every" in target) {
		const scopes = allScopes(call).filter((scope) => hasSetupCommand(scope.io.env));
		if (scopes.length === 0) {
			io.stderr.write('pi-space: No profile has a setup command; give one a "setup" in the config file, or give --setup <cmd>.\n');
			return io.exit(2);
		}
		// Every setup command is checked before the first one runs.
		if (!scopes.every((scope) => checkSetup(scope.io, scope.setupSource))) return io.exit(2);
		const failed: string[] = [];
		for (const scope of scopes) await setupEach(scope, listSpaces(scope.dir), failed);
		return finishSetup(failed, io);
	}
	const ref = qualify(target.name, call);
	if (!ref) return;
	const scope = scopeOf(call, ref.profile);
	if (!hasSetupCommand(scope.io.env)) {
		io.stderr.write(noSetup(ref.profile));
		return io.exit(2);
	}
	if (!checkSetup(scope.io, scope.setupSource)) return io.exit(2);
	if (ref.name === EVERY) {
		const failed: string[] = [];
		await setupEach(scope, listSpaces(scope.dir), failed);
		return finishSetup(failed, io);
	}
	if (ref.name !== BASE && !checkSpace(ref.name, scope.dir, io)) return io.exit(1);
	return io.exit(await setupIn(scope, ref.name));
}

function finishSetup(failed: string[], io: CliIo): void {
	if (failed.length > 0) {
		io.stderr.write(`pi-space: setup failed in: ${failed.join(", ")}\n`);
		return io.exit(1);
	}
	io.exit(0);
}

/**
 * Moves one old space of a scope into its agent folder (migrateSpace: backup first, the active space and base homes
 * refused) and returns the message to print. Throws a SpaceError for a refusal.
 */
function migrateOne(scope: Scope, name: string): string {
	const { io, dir, profile } = scope;
	const { home, backup } = migrateSpace(dir, name, agentHome(io.env, io.home), protectedHomes(io, profile), io.home);
	return `Migrated space "${name}": its agent home is now ${home} (backup: ${backup}).`;
}

/** Why a migration failed, as the line to print. */
function migrateFailure(name: string, error: unknown): string {
	return `pi-space: ${error instanceof SpaceError ? error.message : `could not migrate space "${name}": ${(error as Error).message}`}\n`;
}

/** Migrates each of `names`, with a `== <profile>/<name>` header; a space that already has agent/ is skipped with a note, the failures are added to `failed`. */
function migrateEach(scope: Scope, names: string[], failed: string[]): void {
	const { io } = scope;
	for (const name of names) {
		io.stdout.write(`== ${scope.profile.name}/${name}\n`);
		const root = join(scope.dir, name);
		if (isRooted(root)) {
			io.stdout.write(`Space "${name}" already has its agent home in ${spaceHome(root)}; skipped.\n`);
			continue;
		}
		try {
			io.stdout.write(`${migrateOne(scope, name)}\n`);
		} catch (error) {
			io.stderr.write(migrateFailure(name, error));
			failed.push(`${scope.profile.name}/${name}`);
		}
	}
}

/**
 * `pi-space migrate`: moves an old space (its folder is its agent home) into `<root>/agent`, with a copy in .backups first.
 * With <profile>/--every, every space of that profile; with --every, of every profile; never base. A space that already has
 * agent/ is refused (exit 1) when named, skipped with a note under --every; with --every one failure does not stop the
 * rest, and the status is 1 if any failed.
 */
function runMigrate(target: PackageTarget, call: Call): void {
	const { io } = call;
	const finish = (failed: string[]) => {
		if (failed.length > 0) {
			io.stderr.write(`pi-space: migrate failed in: ${failed.join(", ")}\n`);
			return io.exit(1);
		}
		io.exit(0);
	};
	if ("every" in target) {
		const scopes = allScopes(call);
		if (scopes.every((scope) => listSpaces(scope.dir).length === 0)) {
			io.stdout.write("No spaces yet. Create one with pi-space new <profile>/<name>.\n");
			return io.exit(0);
		}
		const failed: string[] = [];
		for (const scope of scopes) migrateEach(scope, listSpaces(scope.dir), failed);
		return finish(failed);
	}
	const ref = qualify(target.name, call);
	if (!ref) return;
	const scope = scopeOf(call, ref.profile);
	if (ref.name === EVERY) {
		const names = listSpaces(scope.dir);
		if (names.length === 0) {
			io.stdout.write(`No spaces yet. Create one with pi-space new ${ref.profile}/<name>.\n`);
			return io.exit(0);
		}
		const failed: string[] = [];
		migrateEach(scope, names, failed);
		return finish(failed);
	}
	if (ref.name === BASE) {
		io.stderr.write("pi-space: migrate runs only on spaces, not on base (the home Pi starts with).\n");
		return io.exit(1);
	}
	if (!checkSpace(ref.name, scope.dir, io)) return io.exit(1);
	try {
		io.stdout.write(`${migrateOne(scope, ref.name)}\n`);
		return io.exit(0);
	} catch (error) {
		io.stderr.write(migrateFailure(ref.name, error));
		return io.exit(1);
	}
}

/** A picker item: `<profile>/<name>` shown, and the profile and space it starts. */
interface PickerChoice extends PickerItem {
	profile: string;
	space: string;
}

/**
 * The choices of the picker: base and the spaces of every profile, as `<profile>/<name>`, in the order of
 * orderedProfileNames; under the profile's name as a header when there is more than one profile. A profile that shares a
 * folder with another is listed too (each runs its own command). The space this Pi runs in (PI_SPACE_HOME) is the active one.
 */
function pickerChoices(call: Call): PickerChoice[] {
	const activeHome = call.io.env.PI_SPACE_HOME;
	// The pinned space, if any and valid, is where the cursor starts.
	const pinFile = findPin(currentFolder(call.io), call.io.home);
	const pinned = pinFile === undefined ? undefined : readPin(pinFile).name;
	const scopes = allScopes(call);
	return scopes.flatMap(({ profile, dir }) =>
		[BASE, ...listSpaces(dir)].map((space): PickerChoice => {
			const home = space === BASE ? profile.home : spaceHome(join(dir, space));
			return {
				name: `${profile.name}/${space}`,
				...(scopes.length > 1 ? { group: profile.name } : {}),
				profile: profile.name,
				space,
				...(activeHome && samePath(home, activeHome) ? { active: true } : {}),
				...(pinned === `${profile.name}/${space}` ? { selected: true, pinned: true } : {}),
			};
		}),
	);
}

/**
 * A bare `pi-space` on a terminal: the picker over every profile, then Pi in the chosen space with that profile's
 * settings (and the --setup and --config of this call). Esc or the end of input exit 0; Ctrl-C exits 130.
 */
async function pick(call: Call): Promise<void> {
	const { io } = call;
	if (!io.stdin.isTTY) {
		io.stderr.write(USAGE);
		return io.exit(2);
	}
	const { item, interrupted } = await runPicker(pickerChoices(call), io);
	if (item === undefined) return io.exit(interrupted ? 130 : 0);
	const choice = item as PickerChoice;
	// Its command was not checked before the picker: launch reports an unclosed quote.
	return launch(choice.space, [], scopeOf(call, choice.profile));
}

// A space pinned to a folder (see pi-spaces/pin): a bare pi-space starts it, pin writes it, unpin removes it.

function currentFolder(io: CliIo): string {
	return resolve(io.cwd ?? process.cwd());
}

/** readPin's name, or exit: 1 naming the file and the reason when it cannot be read, 2 with the form when it names no space. */
function pinnedName(file: string, io: CliIo): string | undefined {
	const { name, error } = readPin(file);
	if (error !== undefined) {
		io.stderr.write(`pi-space: cannot read ${file}: ${error}\n`);
		io.exit(1);
	} else if (name === undefined) {
		io.stderr.write(`pi-space: ${file}: name one space as <profile>/<name>, e.g. pi/work.\n`);
		io.exit(2);
	}
	return name;
}

/** A bare pi-space where a space is pinned: that space, as if it were named, after a line that names the marker. */
async function launchPinned(file: string, call: Call): Promise<void> {
	const name = pinnedName(file, call.io);
	if (name === undefined) return;
	call.io.stderr.write(`pi-space: ${name} (from ${file})\n`);
	const ref = qualify(name, call);
	return ref && (await launch(ref.name, [], scopeOf(call, ref.profile)));
}

/** `pi-space pin --show` (and `pin` without a terminal): the space pinned here and its file, or that there is none. */
function showPin(call: Call): void {
	const { io } = call;
	const file = findPin(currentFolder(io), io.home);
	if (file === undefined) {
		io.stdout.write("No space pinned here.\n");
		return io.exit(0);
	}
	const name = pinnedName(file, io);
	if (name === undefined) return;
	io.stdout.write(`${name} (from ${file})\n`);
	return io.exit(0);
}

/** The first line of the picker of `pi-space pin`. */
const PIN_HINT = `${PINNED_MARK} Pin a space here: ↑/↓ move, Enter pins it, Esc cancels, type to filter`;

/**
 * `pi-space pin` on a terminal: the picker of every profile's spaces, the cursor on the pinned one (else the active
 * one), then pin the chosen space as `pin <profile>/<name>` does. Esc or the end of input exit 0 and change nothing;
 * Ctrl-C exits 130. The home folder is refused before the picker opens.
 */
async function pinPicker(call: Call): Promise<void> {
	const { io } = call;
	const refusal = homeRefusal(pinRoot(currentFolder(io)), io.home);
	if (refusal !== undefined) {
		io.stderr.write(`pi-space: ${refusal}\n`);
		return io.exit(2);
	}
	const { item, interrupted } = await runPicker(pickerChoices(call), io, undefined, undefined, PIN_HINT);
	if (item === undefined) return io.exit(interrupted ? 130 : 0);
	const choice = item as PickerChoice;
	return pinSpace(`${choice.profile}/${choice.space}`, call);
}

/** `pi-space pin <profile>/<name>`: writes the marker once the space is known to exist (see writePin). */
function pinSpace(text: string, call: Call): void {
	const { io } = call;
	const ref = qualify(text, call);
	if (!ref) return;
	const scope = scopeOf(call, ref.profile);
	if (!checkSpace(ref.name, scope.dir, io)) return io.exit(1);
	try {
		io.stdout.write(`${pinnedMessage(writePin(currentFolder(io), io.home, `${ref.profile}/${ref.name}`))}\n`);
	} catch (error) {
		if (!(error instanceof PinError)) throw error;
		io.stderr.write(`pi-space: ${error.message}\n`);
		return io.exit(error.code);
	}
	return io.exit(0);
}

/** `pi-space unpin`: removes the marker that applies here when it is inside the repository (see removePin). */
function unpin(call: Call): void {
	const { io } = call;
	try {
		io.stdout.write(`${unpinnedMessage(removePin(currentFolder(io), io.home))}\n`);
	} catch (error) {
		if (!(error instanceof PinError)) throw error;
		io.stderr.write(`pi-space: ${error.message}\n`);
		return io.exit(error.code);
	}
	return io.exit(0);
}
