// The optional `pi-space` command: pick a space and start Pi in it.
// It only passes `--space <name>`; the extension does the switch, so it never sets PI_CODING_AGENT_DIR.
import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { BASE, type Env, listSpaces, spacesDir, validateName } from "@jals1212/pi-spaces/spaces";

export const USAGE = `Usage: pi-space [<name> [pi args...] | list | --help]
  pi-space              pick a space and start Pi in it
  pi-space <name> ...   start Pi in a space ("base" for the home Pi starts with)
  pi-space list         list the spaces
PI_SPACES_COMMAND sets the program to run (default: pi), e.g. "my-launcher --".
`;

export type CliCommand =
	| { kind: "help" }
	| { kind: "list" }
	| { kind: "picker" }
	| { kind: "usage" }
	| { kind: "launch"; name: string; args: string[] };

/** `list` is the subcommand, so a space named "list" can only be opened from the picker. */
export function parseCli(args: string[]): CliCommand {
	const [first, ...rest] = args;
	if (first === undefined) return { kind: "picker" };
	if (first === "--help" || first === "-h") return { kind: "help" };
	if (first === "list") return rest.length === 0 ? { kind: "list" } : { kind: "usage" };
	return { kind: "launch", name: first, args: rest };
}

/** The program and arguments that start Pi in a space: $PI_SPACES_COMMAND (default pi) plus --space <name>. */
export function launchCommand(env: Env, name: string, args: string[]): { program: string; args: string[] } {
	const [program = "pi", ...prefix] = (env.PI_SPACES_COMMAND ?? "").split(/\s+/).filter(Boolean);
	return { program, args: [...prefix, "--space", name, ...args] };
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
	home: string;
	spawn(program: string, args: string[], options: { stdio: "inherit"; shell: boolean }): Promise<SpawnResult>;
	exit(code: number): void;
}

/** The real child process: stdio inherited, the environment unchanged, a shell on Windows so .cmd shims work. */
export function spawnChild(program: string, args: string[], options: { stdio: "inherit"; shell: boolean }): Promise<SpawnResult> {
	// Ctrl-C belongs to Pi while it runs; this process waits for it instead of dying first.
	const ignore = () => {};
	process.on("SIGINT", ignore);
	return new Promise<SpawnResult>((resolve) => {
		const child = nodeSpawn(program, args, options);
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
	const dir = spacesDir(io.env, io.home);
	const command = parseCli(argv);
	switch (command.kind) {
		case "help":
			io.stdout.write(USAGE);
			return io.exit(0);
		case "usage":
			io.stderr.write(USAGE);
			return io.exit(2);
		case "list": {
			const spaces = listSpaces(dir);
			const lines = [`Spaces in ${dir}:`, `  ${BASE}`, ...spaces.map((name) => `  ${name}`)];
			if (spaces.length === 0) lines.push("No spaces yet. Create one with /space new <name> inside Pi.");
			io.stdout.write(`${lines.join("\n")}\n`);
			return io.exit(0);
		}
		case "launch":
			return launch(command.name, command.args, dir, io);
		case "picker":
			return pick(dir, io);
	}
}

async function launch(name: string, args: string[], dir: string, io: CliIo): Promise<void> {
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
	const { program, args: programArgs } = launchCommand(io.env, name, args);
	const result = await io.spawn(program, programArgs, { stdio: "inherit", shell: process.platform === "win32" });
	if (result.error) {
		io.stderr.write(`pi-space: could not start ${program}: ${result.error.message}\n`);
		return io.exit(1);
	}
	io.exit(result.status ?? 1);
}

async function pick(dir: string, io: CliIo): Promise<void> {
	if (!io.stdin.isTTY) {
		io.stderr.write(USAGE);
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
	return launch(names[number - 1], [], dir, io);
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
