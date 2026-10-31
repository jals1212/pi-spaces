// The optional `pi-space` command: pick a space and start Pi in it, and manage the spaces and their packages.
// It only passes `--space <name>` (and, for a package command, Pi's command after it); the extension does the
// switch, so it sets PI_CODING_AGENT_DIR only for the setup command, which is not Pi and does no switch.
// Profiles of the config file (--profile, "default") stand in for the command, the spaces folder and the setup.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
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
	spacesDir,
	validateName,
} from "@jals1212/pi-spaces/spaces";
import {
	ConfigError,
	type Config,
	configPath,
	loadConfig,
	type Profile,
	profileByName,
	profileNames,
	spaceEnvFor,
} from "@jals1212/pi-spaces/config";

export const USAGE = `Usage: pi-space [--command <cmd>] [--dir <path>] [--setup <cmd>] [--profile <name>] [--config <path>] [<name> [pi args...] | <command> ...]
       pi-space --help | --version
  pi-space                                    pick a space and start Pi in it
  pi-space <name> [pi args...]                start Pi in a space ("base" for the home Pi starts with)
  pi-space list                               list the spaces
  pi-space list <name|--every>                list the packages of a space
  pi-space new <name>                         create a space, then run the setup command in it when there is one
  pi-space setup <name|--every>               run the setup command in a space, or in every space (never in base)
  pi-space rename <old> <new>                 rename a space
  pi-space remove <name>                      delete a space and everything in it, after asking, and keep a backup in .backups unless told not to
                                              (--yes skips the questions; --no-backup deletes without a backup)
  pi-space update <name|--every>              update the packages of a space (more words go to Pi: --extensions, --all, a source)
  pi-space install <name|--every> <source>    install a package in a space (more words go to Pi)
  pi-space uninstall <name|--every> <source>  remove a package from a space (more words go to Pi)
  pi-space completion zsh                     print the zsh completion script (source <(pi-space completion zsh))
  pi-space <command> --help                   the help of one command
  pi-space --help                             print this help
  pi-space --version                          print the version
  --every takes the place of the name: base first (not for setup), then every space in turn; a failure does not stop the rest, and the exit status is 1 if any failed.
Options before the command, for this call only:
  --command <cmd>                             the program to run instead of $PI_SPACES_COMMAND (default: pi), e.g. "my-launcher --"
  --dir <path>                                the spaces folder instead of $PI_SPACES_DIR; the Pi it starts gets it too
  --setup <cmd>                               the setup command instead of $PI_SPACES_SETUP; {home} and {name} become the space's folder and name
  --profile <name>                            the profile of the config file to use instead of its "default": its command, spaces folder, setup and spaceEnv
  --config <path>                             the config file instead of $PI_SPACES_CONFIG (default: ~/.pi-spaces/config.json); the Pi it starts gets it too
`;

/** This package's version; package.json sits one folder above both src/ and dist/. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** --command, --dir, --setup, --profile and --config: for this call only, so nothing has to be exported into the shell. */
export interface CallOptions {
	command?: string;
	dir?: string;
	setup?: string;
	profile?: string;
	config?: string;
}

/** The Pi commands that pi-space runs in one space or in every space. */
export type PackageVerb = "list" | "update" | "install" | "uninstall";

/** A space name (or `base`), or every space: base first, then the spaces in order. */
export type PackageTarget = { name: string } | { every: true };

const PACKAGE_VERBS: readonly string[] = ["list", "update", "install", "uninstall"];

/** The old options, and the command that replaced each. */
const REPLACED = {
	"--new": "pi-space new <name>",
	"--remove": "pi-space remove <name> [--yes] [--no-backup]",
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

const CALL_OPTIONS = { "--command": "command", "--dir": "dir", "--setup": "setup", "--profile": "profile", "--config": "config" } as const;

function isHelpFlag(word: string): boolean {
	return word === "--help" || word === "-h";
}

/** What each call option is, for the help of the commands it applies to. */
const CALL_HELP: Record<keyof CallOptions, [label: string, text: string]> = {
	command: ["--command <cmd>", 'the program to run instead of $PI_SPACES_COMMAND (default: pi), e.g. "my-launcher --"'],
	dir: ["--dir <path>", "the spaces folder instead of $PI_SPACES_DIR; the Pi it starts gets it too"],
	setup: ["--setup <cmd>", "the setup command instead of $PI_SPACES_SETUP; {home} and {name} become the space's folder and name"],
	profile: ["--profile <name>", 'the profile of the config file instead of its "default"'],
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
	["<name>", "base or a space"],
	["--every", "base first, then every space in turn; a failure does not stop the rest, and the exit status is 1 if any failed"],
];

/** The commands, in the order completion lists them. They are reserved words: the core never lets a space be named one. */
const COMMANDS: Record<string, CommandHelp> = {
	list: {
		summary: "list the spaces, or the packages of one",
		usage: "list [<name|--every>]",
		about: ["With a name it runs Pi's list in that space; with --every, in base and then every space."],
		args: NAME_OR_EVERY,
		options: [],
		calls: ["command", "dir", "profile", "config"],
		examples: ["pi-space list", "pi-space list work", "pi-space list --every"],
	},
	new: {
		summary: "create a space",
		usage: "new <name>",
		about: ["Its settings.json declares the extension. It runs the setup command in it when there is one, and does not start Pi."],
		args: [["<name>", "the name of the new space"]],
		options: [],
		calls: ["dir", "setup", "profile", "config"],
		examples: ["pi-space new work", "pi-space --setup 'my-launcher --home {home} setup' new work"],
	},
	setup: {
		summary: "run the setup command in a space",
		usage: "setup <name|--every>",
		about: ["It needs a setup command: --setup or $PI_SPACES_SETUP. It never runs in base."],
		args: [
			["<name>", "a space"],
			["--every", "every space, never base; a failure does not stop the rest, and the exit status is 1 if any failed"],
		],
		options: [],
		calls: ["dir", "setup", "profile", "config"],
		examples: ["pi-space setup work", "pi-space setup --every", "pi-space --setup 'my-launcher --home {home} setup' setup --every"],
	},
	rename: {
		summary: "rename a space",
		usage: "rename <old> <new>",
		about: ["It refuses what remove refuses: base, the space you are in, and a space that holds the base home."],
		args: [
			["<old>", "the space to rename"],
			["<new>", "its new name"],
		],
		options: [],
		calls: ["dir", "profile", "config"],
		examples: ["pi-space rename work client"],
	},
	remove: {
		summary: "delete a space, keeping a backup",
		usage: "remove <name> [--yes|-y] [--no-backup]",
		about: ["It deletes the space and everything in it, after asking, and keeps a backup in .backups unless told not to."],
		args: [["<name>", "the space to delete"]],
		options: [
			{ flag: "--yes", alias: "-y", text: "do not ask; keep a backup" },
			{ flag: "--no-backup", text: "delete without a backup" },
		],
		calls: ["dir", "profile", "config"],
		examples: ["pi-space remove work", "pi-space remove work --yes", "pi-space remove work --yes --no-backup"],
	},
	update: {
		summary: "update the packages of a space",
		usage: "update <name|--every> [pi args...]",
		about: ["It runs Pi's update in a space, or in base and then every space."],
		args: [...NAME_OR_EVERY, PI_ARGS],
		options: [],
		calls: ["command", "dir", "profile", "config"],
		examples: ["pi-space update work", "pi-space update base --extensions", "pi-space --command 'my-launcher --' update --every"],
	},
	install: {
		summary: "install a package in a space",
		usage: "install <name|--every> <source> [pi args...]",
		about: ["It runs Pi's install in a space, or in base and then every space."],
		args: [...NAME_OR_EVERY, ["<source>", "the package to install, e.g. npm:some-package"], PI_ARGS],
		options: [],
		calls: ["command", "dir", "profile", "config"],
		examples: ["pi-space install work npm:some-package", "pi-space install --every npm:some-package"],
	},
	uninstall: {
		summary: "remove a package from a space",
		usage: "uninstall <name|--every> <source> [pi args...]",
		about: ["It runs Pi's uninstall (its alias of remove) in a space, or in base and then every space."],
		args: [...NAME_OR_EVERY, ["<source>", "the package to remove, e.g. npm:some-package"], PI_ARGS],
		options: [],
		calls: ["command", "dir", "profile", "config"],
		examples: ["pi-space uninstall work npm:some-package", "pi-space uninstall --every npm:some-package"],
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
 * The call options (--command, --dir, --setup, --profile, --config) come first; after a space name every argument belongs to Pi.
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
 * The program and arguments that start Pi in a space: $PI_SPACES_COMMAND (default pi) plus --space <name>.
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

/** The agent home Pi uses from this shell: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
function agentHome(env: Env, home: string): string {
	return env.PI_CODING_AGENT_DIR ? env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, home) : join(home, ".pi", "agent");
}

export interface SpawnOptions {
	stdio: "inherit";
	/** Set with --dir, --setup or --config, when a profile supplies the dir or setup, and for a setup command; otherwise the child inherits this process's environment unchanged. */
	env?: Env;
}

export interface SpawnResult {
	status: number | null;
	error?: Error;
}

export interface CliIo {
	stdin: NodeJS.ReadableStream & { isTTY?: boolean };
	stdout: { write(text: string): unknown };
	stderr: { write(text: string): unknown };
	env: Env;
	/** The environment for the started Pi when --dir, --setup or --config is given or a profile supplies a dir or setup; otherwise it inherits this process's. */
	childEnv?: Env;
	home: string;
	spawn(program: string, args: string[], options: SpawnOptions): Promise<SpawnResult>;
	exit(code: number): void;
}

/**
 * The real child process: stdio inherited, the environment unchanged. cross-spawn is plain child_process.spawn
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

/** Where a setting came from, which decides what the started Pi is told and how an error names it. */
type Origin = "option" | "profile" | "env";

/** What one call settled: its environment, the spaces folder, the profile it runs under and where each setting came from. */
interface Settings {
	/** The io with this call's environment and the environment of the started Pi. */
	io: CliIo;
	dir: string;
	config: Config | undefined;
	/** The profile asked for with --profile, else the config's default; undefined without either. */
	profile: Profile | undefined;
	commandSource: string;
	setupSource: string;
}

/** Whether the file itself gives the profile a `dir` (the resolved one always has one). */
function hasOwnDir(config: Config | undefined, profile: Profile): boolean {
	return config?.profiles.find((spec) => spec.name === profile.name)?.dir !== undefined;
}

/**
 * The command or setup of this call, with where it came from: the call option, then the --profile profile, then
 * the environment variable, then the default profile. A blank variable is none.
 */
function choose(field: "command" | "setup", call: CallOptions, asked: Profile | undefined, fallback: Profile | undefined, env: Env): { value: string; origin: Origin; source: string } | undefined {
	const variable = field === "command" ? "PI_SPACES_COMMAND" : "PI_SPACES_SETUP";
	const named = (profile: Profile | undefined) => `profile "${profile?.name}" ${field}`;
	const candidates: [string | undefined, Origin, string][] = [
		[call[field], "option", `--${field}`],
		[asked?.[field], "profile", named(asked)],
		[env[variable]?.trim() ? env[variable] : undefined, "env", variable],
		[fallback?.[field], "profile", named(fallback)],
	];
	const found = candidates.find(([value]) => value !== undefined);
	return found && { value: found[0] as string, origin: found[1], source: found[2] };
}

/**
 * Reads the config file, picks the profile and applies the precedence: call option > --profile > PI_SPACES_* >
 * the default profile > built-in. The call's own environment gets the winners (so the rest of the CLI reads
 * PI_SPACES_COMMAND, PI_SPACES_DIR and PI_SPACES_SETUP as ever); the started Pi gets --dir, --setup, --config and
 * what a profile supplies for the folder and the setup, but never --command. Throws a ConfigError.
 */
function resolveSettings(call: CallOptions, io: CliIo): Settings {
	const configFile = call.config !== undefined ? resolve(call.config) : configPath(io.env, io.home);
	const config = loadConfig(configFile);
	const asked = call.profile !== undefined ? profileByName(config, call.profile, io.env, io.home) : undefined;
	// With --profile the default is not consulted: a profile never borrows from another.
	const fallback = asked === undefined && config?.default !== undefined ? profileByName(config, config.default, io.env, io.home) : undefined;
	const env: Env = { ...io.env };
	const forChild: Env = {};
	if (call.config !== undefined) forChild.PI_SPACES_CONFIG = configFile;
	if (call.dir !== undefined) {
		// Absolute: a relative one is relative to where the command runs.
		forChild.PI_SPACES_DIR = resolve(call.dir);
	} else if (asked) {
		env.PI_SPACES_DIR = asked.dir;
		// The Pi would find the same folder by itself unless the file names it or PI_SPACES_DIR would win there.
		if (hasOwnDir(config, asked) || io.env.PI_SPACES_DIR) forChild.PI_SPACES_DIR = asked.dir;
	} else if (fallback && !io.env.PI_SPACES_DIR && hasOwnDir(config, fallback)) {
		forChild.PI_SPACES_DIR = fallback.dir;
	}
	const command = choose("command", call, asked, fallback, io.env);
	const setup = choose("setup", call, asked, fallback, io.env);
	if (command && command.origin !== "env") env.PI_SPACES_COMMAND = command.value;
	if (setup && setup.origin !== "env") forChild.PI_SPACES_SETUP = env.PI_SPACES_SETUP = setup.value;
	Object.assign(env, forChild);
	const dir = spacesDir(env, io.home, fallback?.dir);
	return {
		io: { ...io, env, childEnv: Object.keys(forChild).length > 0 ? { ...io.env, ...forChild } : undefined },
		dir,
		config,
		profile: asked ?? fallback,
		commandSource: command?.source ?? "PI_SPACES_COMMAND",
		setupSource: setup?.source ?? "PI_SPACES_SETUP",
	};
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
	let settings: Settings;
	try {
		settings = resolveSettings(command, io);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		io.stderr.write(`pi-space: ${error.message}\n`);
		return io.exit(2);
	}
	const { dir, profile, commandSource, setupSource } = settings;
	io = settings.io;
	switch (command.kind) {
		case "list": {
			const spaces = listSpaces(dir);
			const lines = [`Spaces in ${dir}:`, `  ${BASE}`, ...spaces.map((name) => `  ${name}`)];
			if (spaces.length === 0) lines.push("No spaces yet. Create one with pi-space new <name>.");
			io.stdout.write(`${lines.join("\n")}\n`);
			return io.exit(0);
		}
		case "packages":
			return runPackages(command.verb, command.target, command.args, dir, io, commandSource);
		case "new":
			return create(command.name, dir, io, setupSource, profile);
		case "setup":
			return runSetup(command.target, dir, io, setupSource, profile);
		case "rename":
			return rename(command.from, command.to, dir, io, profile);
		case "remove":
			return remove(command.name, command.yes, command.backup, dir, io, profile);
		case "launch":
			return launch(command.name, command.args, dir, io, commandSource);
		case "picker":
			return pick(dir, io, commandSource);
	}
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
	"  local -a lines cmds spaces targets profiles shells opts",
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
	'      profile) profiles+=("$value:$text") ;;',
	'      shell) shells+=("$value:$text") ;;',
	'      option) [[ "$PREFIX" == -* ]] && opts+=("$value:$text") ;;',
	"    esac",
	"  done",
	"  (( $#cmds )) && _describe -t commands 'command' cmds && ret=0",
	"  (( $#spaces )) && _describe -t spaces 'space' spaces && ret=0",
	"  (( $#targets )) && _describe -t targets 'target' targets && ret=0",
	"  (( $#profiles )) && _describe -t profiles 'profile' profiles && ret=0",
	"  (( $#shells )) && _describe -t shells 'shell' shells && ret=0",
	"  (( $#opts )) && _describe -t options 'option' opts && ret=0",
	"  return ret",
	"}",
	"compdef _pi_space pi-space",
	"",
].join("\n");

/** The groups of a `__complete` line; `target` is --every, which stands in for a space name. */
type Group = "command" | "space" | "target" | "profile" | "shell" | "option";

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

/** `base`, if asked, then the spaces. */
function spaceCandidates(spaces: string[], withBase: boolean): string[] {
	return [...(withBase ? [candidate("space", BASE, "the home Pi starts with")] : []), ...spaces.map((name) => candidate("space", name, "space"))];
}

/** What follows a command word: its target, its own options and --help. */
function commandArguments(command: string, spaces: string[]): string[] {
	const every = (text: string) => candidate("target", "--every", text);
	const options = [...COMMANDS[command].options, HELP_OPTION].map((option) => candidate("option", option.flag, option.text));
	switch (command) {
		case "remove":
		case "rename":
			return [...spaceCandidates(spaces, false), ...options];
		case "setup":
			return [...spaceCandidates(spaces, false), every("every space"), ...options];
		case "list":
		case "update":
		case "install":
		case "uninstall":
			return [...spaceCandidates(spaces, true), every("every space (base first)"), ...options];
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
		if (index + 1 >= words.length) return optionValues(option, call, io);
		call[CALL_OPTIONS[option]] = words[index + 1];
		index += 2;
	}
	const { dir } = resolveSettings(call, io);
	const rest = words.slice(index);
	const spaces = listSpaces(dir);
	if (rest.length === 0) return [...commandCandidates(false), ...spaceCandidates(spaces, true), ...firstOptions(call, index === 0)];
	if (rest.length > 1) return [];
	if (isHelpFlag(rest[0])) return commandCandidates(true);
	if (!Object.hasOwn(COMMANDS, rest[0])) return [];
	return commandArguments(rest[0], spaces);
}

/** The candidates for the value of a call option: profile names with their command, the shell's files for a path, nothing for a command. */
function optionValues(option: keyof typeof CALL_OPTIONS, call: CallOptions, io: CliIo): string[] {
	if (option === "--profile") {
		const { config } = resolveSettings(call, io);
		return profileNames(config).map((name) => candidate("profile", name, profileText(config, name, io)));
	}
	if (option === "--config" || option === "--dir") return [FILES];
	return [];
}

/** A profile's command, else "profile". */
function profileText(config: Config | undefined, name: string, io: CliIo): string {
	try {
		return profileByName(config, name, io.env, io.home).command || "profile";
	} catch {
		return "profile";
	}
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
function spawnSetup(setup: { program: string; args: string[] }, name: string, home: string, io: CliIo, profile: Profile | undefined): Promise<number> {
	// The profile's spaceEnv, for this space, then the three variables of the space, which a profile cannot set.
	const spaceEnv = profile ? spaceEnvFor(profile, home, name) : {};
	return spawnPi(setup.program, setup.args, io, { ...io.env, ...spaceEnv, PI_CODING_AGENT_DIR: home, PI_SPACE: name, PI_SPACE_HOME: home });
}

/** The setup command for one space, from PI_SPACES_SETUP after the call options; checkSetup has accepted it. */
function setupFor(name: string, home: string, io: CliIo): { program: string; args: string[] } {
	return setupCommand(io.env.PI_SPACES_SETUP ?? "", home, name);
}

async function create(name: string, dir: string, io: CliIo, setupSource: string, profile: Profile | undefined): Promise<void> {
	const withSetup = hasSetupCommand(io.env);
	// A bad setup command is reported before anything is created.
	if (withSetup && !checkSetup(io, setupSource)) return io.exit(2);
	try {
		const path = createSpace(dir, name, newSpaceDeclaration(io.env, io.home, profile?.home));
		io.stdout.write(`Created space "${name}" at ${path}.\n`);
		if (withSetup) {
			const setup = setupFor(name, path, io);
			io.stdout.write(`Setting it up: ${[setup.program, ...setup.args].join(" ")}\n`);
			const status = await spawnSetup(setup, name, path, io, profile);
			if (status !== 0) {
				io.stderr.write(`pi-space: Setup failed in space "${name}" (exit status ${status}); the space is kept. Run it again with: pi-space setup ${name}\n`);
				return io.exit(status);
			}
		}
		io.stdout.write(`Start Pi in it with: pi-space ${name}\n`);
		return io.exit(0);
	} catch (error) {
		// A SpaceError is a rule (a bad or taken name); anything else is the filesystem, such as no permission.
		io.stderr.write(`pi-space: ${error instanceof SpaceError ? error.message : `could not create space "${name}": ${(error as Error).message}`}\n`);
		return io.exit(1);
	}
}

/** The base homes a space must not be: the one Pi started with, and the selected profile's. */
function protectedHomes(io: CliIo, profile: Profile | undefined): string[] {
	return [io.env.PI_SPACES_BASE_HOME, profile?.home].filter((home): home is string => Boolean(home));
}

/** Renames a space after the same checks as remove: not base, not the active space, not one that holds the base home. */
function rename(from: string, to: string, dir: string, io: CliIo, profile: Profile | undefined): void {
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
async function remove(name: string, yes: boolean, backup: boolean, dir: string, io: CliIo, profile: Profile | undefined): Promise<void> {
	const current = agentHome(io.env, io.home);
	const protect = protectedHomes(io, profile);
	let reader: LineReader | undefined;
	try {
		// Fail before asking when the space cannot be removed anyway.
		const path = checkRemovable(dir, name, current, protect, io.home);
		let keep = backup;
		if (!yes) {
			if (!io.stdin.isTTY) throw new SpaceError(`Removing a space needs confirmation; run pi-space remove ${name} --yes.`);
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

async function launch(name: string, args: string[], dir: string, io: CliIo, commandSource: string): Promise<void> {
	if (!checkSpace(name, dir, io)) return io.exit(1);
	let launched: { program: string; args: string[] };
	try {
		launched = launchCommand(io.env, name, args);
	} catch (error) {
		io.stderr.write(`pi-space: ${commandSource}: ${(error as Error).message}.\n`);
		return io.exit(2);
	}
	io.exit(await spawnPi(launched.program, launched.args, io, io.childEnv));
}

/**
 * Runs one of Pi's package commands in a space, or in base and then every space with --every, through the same
 * Pi (`--space <name> <verb> [args...]`): the extension relaunches it in that home, so the home is never set here.
 * With --every each run gets a `== <name>` header, one failure does not stop the rest, and the status is 1 if any failed.
 */
async function runPackages(verb: PackageVerb, target: PackageTarget, args: string[], dir: string, io: CliIo, commandSource: string): Promise<void> {
	const names = "every" in target ? [BASE, ...listSpaces(dir)] : [target.name];
	if (!("every" in target) && !checkSpace(target.name, dir, io)) return io.exit(1);
	const failed: string[] = [];
	for (const name of names) {
		let launched: { program: string; args: string[] };
		try {
			launched = launchCommand(io.env, name, [verb, ...args]);
		} catch (error) {
			// The same command for every space, so this is reported once, before any header.
			io.stderr.write(`pi-space: ${commandSource}: ${(error as Error).message}.\n`);
			return io.exit(2);
		}
		if ("every" in target) io.stdout.write(`== ${name}\n`);
		const status = await spawnPi(launched.program, launched.args, io, io.childEnv);
		if (!("every" in target)) return io.exit(status);
		if (status !== 0) failed.push(name);
	}
	if (failed.length > 0) {
		io.stderr.write(`pi-space: ${verb} failed in: ${failed.join(", ")}\n`);
		return io.exit(1);
	}
	io.exit(0);
}

/**
 * Runs the setup command in a space, or in every space with --every (never base), as `pi-space setup`.
 * With --every each run gets a `== <name>` header, one failure does not stop the rest, and the status is 1 if any failed.
 */
async function runSetup(target: PackageTarget, dir: string, io: CliIo, setupSource: string, profile: Profile | undefined): Promise<void> {
	if (!hasSetupCommand(io.env)) {
		io.stderr.write("pi-space: There is no setup command; set PI_SPACES_SETUP or give --setup <cmd>.\n");
		return io.exit(2);
	}
	if (!checkSetup(io, setupSource)) return io.exit(2);
	if (!("every" in target)) {
		if (target.name === BASE) {
			io.stderr.write("pi-space: setup runs only in spaces, not in base (the home Pi starts with).\n");
			return io.exit(1);
		}
		if (!checkSpace(target.name, dir, io)) return io.exit(1);
		const home = join(dir, target.name);
		return io.exit(await spawnSetup(setupFor(target.name, home, io), target.name, home, io, profile));
	}
	const names = listSpaces(dir);
	if (names.length === 0) {
		io.stdout.write("No spaces yet. Create one with pi-space new <name>.\n");
		return io.exit(0);
	}
	const failed: string[] = [];
	for (const name of names) {
		io.stdout.write(`== ${name}\n`);
		const home = join(dir, name);
		if ((await spawnSetup(setupFor(name, home, io), name, home, io, profile)) !== 0) failed.push(name);
	}
	if (failed.length > 0) {
		io.stderr.write(`pi-space: setup failed in: ${failed.join(", ")}\n`);
		return io.exit(1);
	}
	io.exit(0);
}

async function pick(dir: string, io: CliIo, commandSource: string): Promise<void> {
	if (!io.stdin.isTTY) {
		io.stderr.write(USAGE);
		return io.exit(2);
	}
	// A bad command is reported before the list, not after the user has chosen.
	try {
		splitCommand(io.env.PI_SPACES_COMMAND ?? "");
	} catch (error) {
		io.stderr.write(`pi-space: ${commandSource}: ${(error as Error).message}.\n`);
		return io.exit(2);
	}
	const names = [BASE, ...listSpaces(dir)];
	io.stdout.write(`${[`Spaces in ${dir}:`, ...names.map((name, index) => `${index + 1}) ${name}`)].join("\n")}\nSpace number: `);
	const line = await readLine(io.stdin);
	const answer = line?.trim() ?? "";
	if (answer === "") return io.exit(0);
	const number = /^\d+$/.test(answer) ? Number(answer) : 0;
	if (number < 1 || number > names.length) {
		io.stderr.write(`pi-space: Choose a number from 1 to ${names.length}.\n`);
		return io.exit(1);
	}
	return launch(names[number - 1], [], dir, io, commandSource);
}

/** One line from the stream, or undefined at end of input. */
function readLine(input: NodeJS.ReadableStream): Promise<string | undefined> {
	return new Promise((resolve) => {
		const rl = createInterface({ input });
		rl.once("line", (line) => {
			// Resolve first: close() emits "close" synchronously.
			resolve(line);
			rl.close();
		});
		rl.once("close", () => resolve(undefined));
	});
}
