// The optional `pi-space` command: pick a space and start Pi in it, and manage the spaces and their packages.
// It passes `--space <name>` (and, for a package command, Pi's command after it) and the extension does the switch,
// but the Pi it starts runs as if started from a plain terminal for the named profile, whatever Pi the caller is in:
// the caller's space (PI_SPACES_BASE_HOME, PI_SPACE, PI_SPACE_HOME, PI_SPACES_BASE_ENV, its spaceEnv values and the
// paths inside its folder) is unwound back to its base, and PI_CODING_AGENT_DIR is the profile's home. The setup
// command, which is not Pi and does no switch, gets the space's own home and variables on top of that same base.
// Every space is named <profile>/<name>; the profile of the config file stands in for the command, the spaces folder and the setup.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { type PickerItem, type PickerTerminal, runPicker } from "./picker.ts";
import {
	BACKUPS,
	BASE,
	backupSpace,
	checkRemovable,
	createSpace,
	type Env,
	findOwnDeclaration,
	hasSetupCommand,
	listSpaces,
	type PackageDeclaration,
	removeSpace,
	renameSpace,
	SpaceError,
	samePath,
	validateName,
} from "@jals1212/pi-spaces/spaces";
import {
	ConfigError,
	type Config,
	configPath,
	loadConfig,
	type Profile,
	profileByName,
	profileForHome,
	profileNames,
	spaceEnvFor,
} from "@jals1212/pi-spaces/config";

export const USAGE = `Usage: pi-space [--command <cmd>] [--dir <path>] [--setup <cmd>] [--config <path>] [<space> [pi args...] | <command> ...]
       pi-space --help | --version
A <space> is <profile>/<name>: a profile of the config file (pi is always there), then the space; base is a space too, as <profile>/base.
  pi-space                                     pick a space and start Pi in it
  pi-space <space> [pi args...]                start Pi in a space (<profile>/base is the home that profile's Pi starts with)
  pi-space list                                list the spaces of every profile
  pi-space list <space|--every>                list the packages of a space
  pi-space new <space>                         create a space, then run the profile's setup command in it when there is one
  pi-space setup <space|--every>               run the setup command in a space, or in every space (never in base)
  pi-space rename <space> <new>                rename a space; the new name is bare or keeps the profile (<profile>/<new>)
  pi-space remove <space>                      delete a space and everything in it, after asking, and keep a backup in .backups unless told not to
                                               (--yes skips the questions; --no-backup deletes without a backup)
  pi-space update <space|--every>              update the packages of a space (more words go to Pi: --extensions, --all, a source)
  pi-space install <space|--every> <source>    install a package in a space (more words go to Pi)
  pi-space uninstall <space|--every> <source>  remove a package from a space (more words go to Pi)
  pi-space completion zsh                      print the zsh completion script (source <(pi-space completion zsh))
  pi-space <command> --help                    the help of one command
  pi-space --help                              print this help
  pi-space --version                           print the version
  --every takes the place of the space: <profile>/--every runs in that profile's base (not for setup) and spaces, --every alone in every profile;
  a failure does not stop the rest, and the exit status is 1 if any failed.
Options before the command, for this call only:
  --command <cmd>                              the program to run instead of the profile's command, e.g. "my-launcher --" (for one profile)
  --dir <path>                                 the spaces folder instead of the profile's; the Pi it starts gets it too (for one profile)
  --setup <cmd>                                the setup command instead of the profile's; {home} and {name} become the space's folder and name
  --config <path>                              the config file instead of $PI_SPACES_CONFIG (default: ~/.pi-spaces/config.json); the Pi it starts gets it too
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
	| { kind: "new"; name: string }
	| { kind: "setup"; target: PackageTarget }
	| { kind: "rename"; from: string; to: string }
	| { kind: "remove"; name: string; yes: boolean; backup: boolean }
	| { kind: "completion"; shell?: string }
	| { kind: "complete"; words: string[] }
	| { kind: "picker" }
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
	setup: ["--setup <cmd>", "the setup command instead of the profile's; {home} and {name} become the space's folder and name"],
	config: ["--config <path>", "the config file instead of $PI_SPACES_CONFIG (default: ~/.pi-spaces/config.json)"],
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
	["--every", "the same in every profile"],
];

/** The commands, in the order completion lists them. They are reserved words: the core never lets a space be named one. */
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
		usage: "new <space>",
		about: ["Its settings.json declares the extension. It runs the profile's setup command in it when there is one, and does not start Pi."],
		args: [["<space>", "<profile>/<name>: the profile and the name of the new space"]],
		options: [],
		calls: ["dir", "setup", "config"],
		examples: ["pi-space new pi/work", "pi-space --setup 'my-launcher --home {home} setup' new pi/work"],
	},
	setup: {
		summary: "run the setup command in a space",
		usage: "setup <space|--every>",
		about: ["It needs a setup command: the profile's \"setup\" or --setup. It never runs in base."],
		args: [
			["<space>", "<profile>/<name>: a space of a profile"],
			["<profile>/--every", "every space of that profile, never base; a failure does not stop the rest, and the exit status is 1 if any failed"],
			["--every", "every space of every profile that has a setup command (or of all, with --setup)"],
		],
		options: [],
		calls: ["dir", "setup", "config"],
		examples: ["pi-space setup pi/work", "pi-space setup pi/--every", "pi-space setup --every", "pi-space --setup 'my-launcher --home {home} setup' setup --every"],
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
	completion: {
		summary: "print the shell completion script",
		usage: "completion <shell>",
		about: ["Supported shells: zsh."],
		args: [["<shell>", "zsh"]],
		options: [],
		calls: [],
		examples: ["pi-space completion zsh", "source <(pi-space completion zsh)"],
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
		["Arguments:", ...rows(help.args)],
		["Options:", ...rows(options)],
		...(calls.length > 0 ? [["Call options (before the command, for this call only):", ...rows(calls)]] : []),
		["Examples:", ...help.examples.map((example) => `  ${example}`)],
	];
	return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

/**
 * The call options (--command, --dir, --setup, --config) come first; after a space name every argument belongs to Pi.
 * The commands (list, new, setup, remove, rename, update, install, uninstall, completion) are reserved words, so they
 * are read before a name: the core never lets a space have one of them as its name. `__complete` is the hidden
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
	if (first === "new") return rest.length === 1 ? { kind: "new", name: rest[0] } : { kind: "usage" };
	if (first === "setup") return parseSetup(rest);
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

/** `setup <name>` or `setup --every`: exactly one argument. */
function parseSetup(rest: string[]): CliCommand {
	if (rest.length !== 1) return { kind: "usage" };
	if (rest[0] === "--every") return { kind: "setup", target: { every: true } };
	if (rest[0].startsWith("-")) return { kind: "unknown-option", option: rest[0] };
	return { kind: "setup", target: { name: rest[0] } };
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

/**
 * The program and arguments that start Pi in a space: PI_SPACES_COMMAND of this env (default pi) plus --space <name>.
 * Throws when the command has an unclosed quote.
 */
export function launchCommand(env: Env, name: string, args: string[]): { program: string; args: string[] } {
	const [program = "pi", ...prefix] = splitCommand(env.PI_SPACES_COMMAND ?? "");
	return { program, args: [...prefix, "--space", name, ...args] };
}

/**
 * The program and arguments of the setup command for one space: the template split like --command, with every
 * {home} and {name} in each word replaced by the space's folder and name. Throws when it has an unclosed quote.
 */
export function setupCommand(template: string, home: string, name: string): { program: string; args: string[] } {
	// Replacer functions, so a "$" in the folder or name is put in as written, never read as a pattern.
	const fill = (word: string) => word.replaceAll("{home}", () => home).replaceAll("{name}", () => name);
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

const EXTENSION = "@jals1212/pi-spaces";

/**
 * The extension's declaration for a new space's settings.json: the one in the base home's settings.json
 * (the selected profile's home, else PI_SPACES_BASE_HOME, else PI_CODING_AGENT_DIR, else ~/.pi/agent),
 * else npm:@jals1212/pi-spaces.
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
	};
}

/** The scopes of every profile, in the order of profileNames. */
function allScopes(call: Call): Scope[] {
	return profileNames(call.config).map((name) => scopeOf(call, name));
}

/**
 * Splits `<profile>/<name>` at the first "/". A name without its profile exits 2 with the form to use, and gives
 * undefined, so the caller returns.
 */
function qualify(text: string, call: Call): { profile: string; name: string } | undefined {
	const slash = text.indexOf("/");
	if (slash > 0) return { profile: text.slice(0, slash), name: text.slice(slash + 1) };
	call.io.stderr.write(`pi-space: Name the space with its profile, as <profile>/${slash === 0 ? text.slice(1) : text} (profiles: ${profileNames(call.config).join(", ")}).\n`);
	call.io.exit(2);
	return undefined;
}

/** Whether a command runs in more than one profile: the picker, `list` alone and --every alone. */
function spansProfiles(command: CliCommand): boolean {
	switch (command.kind) {
		case "picker":
		case "list":
			return true;
		case "packages":
		case "setup":
			return "every" in command.target;
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
	}
	const configFile = command.config !== undefined ? resolve(command.config) : configPath(io.env, io.home);
	try {
		const config = loadConfig(configFile);
		if (config?.default !== undefined) {
			io.stderr.write(`pi-space: ${configFile}: "default" is no longer used; name each space with its profile (<profile>/<name>) and remove "default" from the file.\n`);
		}
		const call: Call = { options: command, config, configFile, io };
		if (spansProfiles(command) && (command.command !== undefined || command.dir !== undefined)) {
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
				return ref && (await create(ref.name, scopeOf(call, ref.profile)));
			}
			case "setup":
				return await runSetup(command.target, call);
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
				return await pick(call);
		}
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		io.stderr.write(`pi-space: ${error.message}\n`);
		return io.exit(2);
	}
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

const SHELLS = ["zsh"];

/** `pi-space completion <shell>`: the script on stdout, or exit 2 for a shell it does not know. */
function printCompletion(shell: string | undefined, io: CliIo): void {
	if (shell === undefined) {
		io.stderr.write(`pi-space: Name a shell: pi-space completion zsh (supported shells: ${SHELLS.join(", ")}).\n`);
		return io.exit(2);
	}
	if (shell !== "zsh") {
		io.stderr.write(`pi-space: Unsupported shell "${shell}"; supported shells: ${SHELLS.join(", ")}.\n`);
		return io.exit(2);
	}
	io.stdout.write(ZSH_COMPLETION);
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
	// The spaces come first, in a group of their own kept in pi-space's (alphabetical) order, so they stay above
	// the commands even when zsh puts every other match in one sorted list (no group-name style, as with fzf-tab).
	"  (( $#spaces )) && _describe -t spaces 'space' spaces -V pi-space-spaces && ret=0",
	"  (( $#cmds )) && _describe -t commands 'command' cmds && ret=0",
	"  (( $#targets )) && _describe -t targets 'target' targets && ret=0",
	"  (( $#shells )) && _describe -t shells 'shell' shells && ret=0",
	"  (( $#opts )) && _describe -t options 'option' opts && ret=0",
	"  return ret",
	"}",
	"compdef _pi_space pi-space",
	// pi-space already gives its candidates in order (spaces first, alphabetical); zsh and fzf-tab must not resort them.
	"zstyle ':completion:*:pi-space:*' sort false",
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

/** The commands with their summary; in first place `completion` is left out (it still works typed in full), after --help it is not. */
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
	spaces: string[];
}

/** `<profile>/base`, if asked, then `<profile>/<name>`, for each profile in order. */
function spaceCandidates(profiles: CompletionProfile[], withBase: boolean): string[] {
	const spaces = profiles.flatMap((profile) => [
		...(withBase ? [{ value: `${profile.name}/${BASE}`, text: `base home of ${profile.name} (${profile.command})` }] : []),
		...profile.spaces.map((name) => ({ value: `${profile.name}/${name}`, text: `space of ${profile.name} (${profile.command})` })),
	]);
	// Alphabetical by the whole name, whatever the order of the profiles in the file.
	spaces.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
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
		case "list":
		case "update":
		case "install":
		case "uninstall":
			return [...spaceCandidates(profiles, true), ...everyCandidates(profiles, "every profile, base first", (name) => `base and every space of ${name}`), ...options];
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
	const profiles = profileNames(config).map((name): CompletionProfile => {
		const profile = profileByName(config, name, io.env, io.home);
		return { name, command: profile.command ?? "pi", spaces: listSpaces(dirOverride ?? profile.dir) };
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
function spawnSetup(setup: { program: string; args: string[] }, name: string, home: string, io: CliIo, profile: Profile): Promise<number> {
	// The profile's spaceEnv, for this space, then the three variables of the space, which a profile cannot set.
	const spaceEnv = spaceEnvFor(profile, home, name);
	return spawnPi(setup.program, setup.args, io, { ...(io.childEnv ?? io.env), ...spaceEnv, PI_CODING_AGENT_DIR: home, PI_SPACE: name, PI_SPACE_HOME: home });
}

/** The setup command for one space, from PI_SPACES_SETUP of this profile's io; checkSetup has accepted it. */
function setupFor(name: string, home: string, io: CliIo): { program: string; args: string[] } {
	return setupCommand(io.env.PI_SPACES_SETUP ?? "", home, name);
}

async function create(name: string, scope: Scope): Promise<void> {
	const { io, dir, profile } = scope;
	const withSetup = hasSetupCommand(io.env);
	// A bad setup command is reported before anything is created.
	if (withSetup && !checkSetup(io, scope.setupSource)) return io.exit(2);
	try {
		const path = createSpace(dir, name, newSpaceDeclaration(io.env, io.home, profile.home));
		io.stdout.write(`Created space "${name}" at ${path}.\n`);
		if (withSetup) {
			const setup = setupFor(name, path, io);
			io.stdout.write(`Setting it up: ${[setup.program, ...setup.args].join(" ")}\n`);
			const status = await spawnSetup(setup, name, path, io, profile);
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
	let launched: { program: string; args: string[] };
	try {
		launched = launchCommand(io.env, name, args);
	} catch (error) {
		io.stderr.write(`pi-space: ${scope.commandSource}: ${(error as Error).message}.\n`);
		return io.exit(2);
	}
	io.exit(await spawnPi(launched.program, launched.args, io, io.childEnv));
}

/**
 * Runs one of Pi's package commands in a space, in base and then every space of a profile (`<profile>/--every`),
 * or in every profile (`--every`), through the same Pi (`--space <name> <verb> [args...]`): the extension relaunches
 * it in that home, so the home is never set here. With --every each run gets a `== <profile>/<name>` header, one
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
			let launched: { program: string; args: string[] };
			try {
				launched = launchCommand(scope.io.env, ref.name, [verb, ...args]);
			} catch (error) {
				io.stderr.write(`pi-space: ${scope.commandSource}: ${(error as Error).message}.\n`);
				return io.exit(2);
			}
			return io.exit(await spawnPi(launched.program, launched.args, scope.io, scope.io.childEnv));
		}
		scopes = [scope];
	}
	// Every command is checked before the first one runs, so a bad one is reported once, before any header.
	for (const scope of scopes) {
		try {
			launchCommand(scope.io.env, BASE, []);
		} catch (error) {
			io.stderr.write(`pi-space: ${scope.commandSource}: ${(error as Error).message}.\n`);
			return io.exit(2);
		}
	}
	const failed: string[] = [];
	for (const scope of scopes) {
		for (const name of [BASE, ...listSpaces(scope.dir)]) {
			const launched = launchCommand(scope.io.env, name, [verb, ...args]);
			io.stdout.write(`== ${scope.profile.name}/${name}\n`);
			if ((await spawnPi(launched.program, launched.args, scope.io, scope.io.childEnv)) !== 0) failed.push(`${scope.profile.name}/${name}`);
		}
	}
	if (failed.length > 0) {
		io.stderr.write(`pi-space: ${verb} failed in: ${failed.join(", ")}\n`);
		return io.exit(1);
	}
	io.exit(0);
}

/** Runs the setup command of a profile in each of `names`, with a `== <profile>/<name>` header; the failures are added to `failed`. */
async function setupEach(scope: Scope, names: string[], failed: string[]): Promise<void> {
	for (const name of names) {
		scope.io.stdout.write(`== ${scope.profile.name}/${name}\n`);
		const home = join(scope.dir, name);
		if ((await spawnSetup(setupFor(name, home, scope.io), name, home, scope.io, scope.profile)) !== 0) failed.push(`${scope.profile.name}/${name}`);
	}
}

/**
 * Runs the setup command in a space, in every space of a profile (`<profile>/--every`), or in every space of every
 * profile that has a setup command (`--every`); never in base. With --every each run gets a `== <profile>/<name>`
 * header, one failure does not stop the rest, and the status is 1 if any failed.
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
		if (scopes.every((scope) => listSpaces(scope.dir).length === 0)) {
			io.stdout.write("No spaces yet. Create one with pi-space new <profile>/<name>.\n");
			return io.exit(0);
		}
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
		const names = listSpaces(scope.dir);
		if (names.length === 0) {
			io.stdout.write(`No spaces yet. Create one with pi-space new ${ref.profile}/<name>.\n`);
			return io.exit(0);
		}
		const failed: string[] = [];
		await setupEach(scope, names, failed);
		return finishSetup(failed, io);
	}
	if (ref.name === BASE) {
		io.stderr.write("pi-space: setup runs only in spaces, not in base (the home Pi starts with).\n");
		return io.exit(1);
	}
	if (!checkSpace(ref.name, scope.dir, io)) return io.exit(1);
	const home = join(scope.dir, ref.name);
	return io.exit(await spawnSetup(setupFor(ref.name, home, scope.io), ref.name, home, scope.io, scope.profile));
}

function finishSetup(failed: string[], io: CliIo): void {
	if (failed.length > 0) {
		io.stderr.write(`pi-space: setup failed in: ${failed.join(", ")}\n`);
		return io.exit(1);
	}
	io.exit(0);
}

/** A picker item: `<profile>/<name>` shown, and the profile and space it starts. */
interface PickerChoice extends PickerItem {
	profile: string;
	space: string;
}

/**
 * The choices of the picker: base and the spaces of every profile, as `<profile>/<name>`, in the order of
 * profileNames; under the profile's name as a header when there is more than one profile. A profile that shares a
 * folder with another is listed too (each runs its own command). The space this Pi runs in (PI_SPACE_HOME) is the active one.
 */
function pickerChoices(call: Call): PickerChoice[] {
	const activeHome = call.io.env.PI_SPACE_HOME;
	const scopes = allScopes(call);
	return scopes.flatMap(({ profile, dir }) =>
		[BASE, ...listSpaces(dir)].map((space): PickerChoice => {
			const home = space === BASE ? profile.home : join(dir, space);
			return {
				name: `${profile.name}/${space}`,
				...(scopes.length > 1 ? { group: profile.name } : {}),
				profile: profile.name,
				space,
				...(activeHome && samePath(home, activeHome) ? { active: true } : {}),
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
