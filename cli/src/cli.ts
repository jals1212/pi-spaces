// The optional `pi-space` command: pick a space and start Pi in it.
// It only passes `--space <name>`; the extension does the switch, so it never sets PI_CODING_AGENT_DIR.
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
	listSpaces,
	type PackageDeclaration,
	removeSpace,
	SpaceError,
	spacesDir,
	validateName,
} from "@jals1212/pi-spaces/spaces";

export const USAGE = `Usage: pi-space [--command <cmd>] [--dir <path>] [<name> [pi args...] | list | --new <name> | --remove <name> [--yes] [--no-backup]]
       pi-space --help | --version
  pi-space                   pick a space and start Pi in it
  pi-space <name> ...        start Pi in a space ("base" for the home Pi starts with)
  pi-space list              list the spaces
  pi-space --new <name>      create a space
  pi-space --remove <name>   delete a space and everything in it, after asking, and keep a backup in .backups unless told not to
                             (--yes skips the questions; --no-backup deletes without a backup)
  pi-space --version         print the version
Options for this call only:
  --command <cmd>            the program to run instead of $PI_SPACES_COMMAND (default: pi), e.g. "my-launcher --"
  --dir <path>               the spaces folder instead of $PI_SPACES_DIR; the Pi it starts gets it too
`;

/** This package's version; package.json sits one folder above both src/ and dist/. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** --command and --dir: for this call only, so nothing has to be exported into the shell. */
export interface CallOptions {
	command?: string;
	dir?: string;
}

export type CliCommand = (
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "unknown-option"; option: string }
	| { kind: "list" }
	| { kind: "new"; name: string }
	| { kind: "remove"; name: string; yes: boolean; backup: boolean }
	| { kind: "picker" }
	| { kind: "usage" }
	| { kind: "launch"; name: string; args: string[] }
) &
	CallOptions;

const CALL_OPTIONS = { "--command": "command", "--dir": "dir" } as const;

/**
 * --command and --dir come first; after a space name every argument belongs to Pi.
 * `list` is the subcommand, so a space named "list" can only be opened from the picker.
 * `--new` and `--remove` are options, not subcommands, so they never take a space name.
 * A space name never starts with "-", so any other option in first place is unknown, not a name.
 */
export function parseCli(args: string[]): CliCommand {
	const options: CallOptions = {};
	let index = 0;
	while (Object.hasOwn(CALL_OPTIONS, args[index] ?? "")) {
		const key = CALL_OPTIONS[args[index] as keyof typeof CALL_OPTIONS];
		const value = args[index + 1];
		if (!value || options[key] !== undefined) return { kind: "usage" };
		options[key] = value;
		index += 2;
	}
	const command = parseCommand(args.slice(index));
	return command.kind === "usage" ? command : { ...command, ...options };
}

function parseCommand(args: string[]): CliCommand {
	const [first, ...rest] = args;
	if (first === undefined) return { kind: "picker" };
	if (first === "--help" || first === "-h") return { kind: "help" };
	if (first === "--version" || first === "-v") return { kind: "version" };
	if (first === "--new") return rest.length === 1 ? { kind: "new", name: rest[0] } : { kind: "usage" };
	if (first === "--remove") {
		const flags = rest.filter((arg) => arg.startsWith("-"));
		const names = rest.filter((arg) => !arg.startsWith("-"));
		const yes = flags.filter((flag) => flag === "--yes" || flag === "-y").length;
		const noBackup = flags.filter((flag) => flag === "--no-backup").length;
		if (names.length !== 1 || yes > 1 || noBackup > 1 || yes + noBackup !== flags.length) return { kind: "usage" };
		return { kind: "remove", name: names[0], yes: yes === 1, backup: noBackup === 0 };
	}
	if (first.startsWith("-")) return { kind: "unknown-option", option: first };
	if (first === "list") return rest.length === 0 ? { kind: "list" } : { kind: "usage" };
	return { kind: "launch", name: first, args: rest };
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
 * (PI_SPACES_BASE_HOME, else PI_CODING_AGENT_DIR, else ~/.pi/agent), else npm:@jals1212/pi-spaces.
 */
export function newSpaceDeclaration(env: Env, home: string): PackageDeclaration {
	const baseHome = env.PI_SPACES_BASE_HOME || agentHome(env, home);
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
	/** Set only with --dir; otherwise the child inherits this process's environment unchanged. */
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
	/** The environment for the started Pi when --dir is given; otherwise it inherits this process's. */
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

export async function main(argv: string[], io: CliIo): Promise<void> {
	const command = parseCli(argv);
	if (command.dir !== undefined || command.command !== undefined) {
		// A relative --dir is relative to where the command runs; the child gets it absolute.
		const env = { ...io.env };
		if (command.dir !== undefined) env.PI_SPACES_DIR = resolve(command.dir);
		if (command.command !== undefined) env.PI_SPACES_COMMAND = command.command;
		io = { ...io, env, childEnv: command.dir !== undefined ? { ...io.env, PI_SPACES_DIR: env.PI_SPACES_DIR } : undefined };
	}
	const commandSource = command.command !== undefined ? "--command" : "PI_SPACES_COMMAND";
	const dir = spacesDir(io.env, io.home);
	switch (command.kind) {
		case "help":
			io.stdout.write(USAGE);
			return io.exit(0);
		case "version":
			io.stdout.write(`${VERSION}\n`);
			return io.exit(0);
		case "unknown-option":
			io.stderr.write(`pi-space: Unknown option "${command.option}".\n${USAGE}`);
			return io.exit(2);
		case "usage":
			io.stderr.write(USAGE);
			return io.exit(2);
		case "list": {
			const spaces = listSpaces(dir);
			const lines = [`Spaces in ${dir}:`, `  ${BASE}`, ...spaces.map((name) => `  ${name}`)];
			if (spaces.length === 0) lines.push("No spaces yet. Create one with pi-space --new <name>.");
			io.stdout.write(`${lines.join("\n")}\n`);
			return io.exit(0);
		}
		case "new":
			return create(command.name, dir, io);
		case "remove":
			return remove(command.name, command.yes, command.backup, dir, io);
		case "launch":
			return launch(command.name, command.args, dir, io, commandSource);
		case "picker":
			return pick(dir, io, commandSource);
	}
}

function create(name: string, dir: string, io: CliIo): void {
	try {
		const path = createSpace(dir, name, newSpaceDeclaration(io.env, io.home));
		io.stdout.write(`Created space "${name}" at ${path}.\nStart Pi in it with: pi-space ${name}\n`);
		return io.exit(0);
	} catch (error) {
		// A SpaceError is a rule (a bad or taken name); anything else is the filesystem, such as no permission.
		io.stderr.write(`pi-space: ${error instanceof SpaceError ? error.message : `could not create space "${name}": ${(error as Error).message}`}\n`);
		return io.exit(1);
	}
}

/**
 * Without --yes it asks to remove ([y/N]), then, without --no-backup, whether to keep a backup ([Y/n]).
 * With --yes it asks nothing and keeps a backup unless --no-backup.
 */
async function remove(name: string, yes: boolean, backup: boolean, dir: string, io: CliIo): Promise<void> {
	const current = agentHome(io.env, io.home);
	const protect = io.env.PI_SPACES_BASE_HOME ? [io.env.PI_SPACES_BASE_HOME] : [];
	let reader: LineReader | undefined;
	try {
		// Fail before asking when the space cannot be removed anyway.
		const path = checkRemovable(dir, name, current, protect, io.home);
		let keep = backup;
		if (!yes) {
			if (!io.stdin.isTTY) throw new SpaceError(`Removing a space needs confirmation; run pi-space --remove ${name} --yes.`);
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

async function launch(name: string, args: string[], dir: string, io: CliIo, commandSource: string): Promise<void> {
	if (name !== BASE) {
		const invalid = validateName(name);
		if (invalid) {
			io.stderr.write(`pi-space: ${invalid}\n`);
			return io.exit(1);
		}
		if (!listSpaces(dir).includes(name)) {
			io.stderr.write(`pi-space: Space "${name}" does not exist.\n`);
			return io.exit(1);
		}
	}
	let launched: { program: string; args: string[] };
	try {
		launched = launchCommand(io.env, name, args);
	} catch (error) {
		io.stderr.write(`pi-space: ${commandSource}: ${(error as Error).message}.\n`);
		return io.exit(2);
	}
	const { program, args: programArgs } = launched;
	const options: SpawnOptions = { stdio: "inherit" };
	if (io.childEnv) options.env = io.childEnv;
	const result = await io.spawn(program, programArgs, options);
	if (result.error) {
		io.stderr.write(`pi-space: could not start ${program}: ${result.error.message}\n`);
		return io.exit(1);
	}
	io.exit(result.status ?? 1);
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
