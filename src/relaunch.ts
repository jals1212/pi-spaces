// Relaunch: Pi reads its agent home once at startup, so entering a space means
// running the same Pi command again with PI_CODING_AGENT_DIR pointing at the space.
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve, sep } from "node:path";
import { activeSpace, BASE, listSpaces, type Env, SpaceError, validateName } from "./spaces.ts";

// Pi options that take a separate value, so the value is kept (or dropped) with them.
const VALUE_OPTIONS = new Set([
	"--provider", "--model", "--api-key", "--thinking", "--models", "--mode", "--export",
	"-t", "--tools", "-xt", "--exclude-tools",
	"-e", "--extension", "--skill", "--prompt-template", "--theme", "--use-theme",
	"--system-prompt", "--append-system-prompt", "--tui-mode",
]);
const DASH_REFUSING = new Set(["--mode", "--use-theme", "--tui-mode"]);
// Pi's own boolean flags, which never take the next word.
const KNOWN_FLAGS = new Set([
	"--print", "--verbose", "--approve", "--no-approve", "--offline", "--help", "--version",
	"--no-builtin-tools", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills",
	"--no-prompt-templates", "--no-themes", "--no-context-files", "--list-models",
]);
// Session options belong to the home being left, so they are dropped.
const SESSION_FLAGS = new Set(["-c", "--continue", "-r", "--resume", "--no-session"]);
const SESSION_VALUE_OPTIONS = new Set(["--session", "--session-id", "--fork", "--session-dir", "-n", "--name"]);

/**
 * The arguments to start Pi with again: options are kept; the initial prompt, @file
 * arguments, session options and everything after "--" are dropped.
 */
export function filterArgs(args: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (!arg.startsWith("-")) continue;
		const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		const inlineValue = name !== arg;
		if (SESSION_FLAGS.has(name)) continue;
		if (SESSION_VALUE_OPTIONS.has(name)) {
			if (!inlineValue) i++;
			continue;
		}
		kept.push(arg);
		if (inlineValue || i + 1 >= args.length) continue;
		const next = args[i + 1];
		if (VALUE_OPTIONS.has(name)) {
			// Pi does not take a dash-led value for these.
			if (!(DASH_REFUSING.has(name) && next.startsWith("-"))) kept.push(args[++i]);
		} else if (name.startsWith("--") && !KNOWN_FLAGS.has(name) && !next.startsWith("-") && !next.startsWith("@")) {
			// Pi gives an unknown (extension) flag the next plain word as its value.
			kept.push(args[++i]);
		}
	}
	return kept;
}

export interface SwitchTarget {
	/** The space to enter, or undefined for the base home. */
	space: string | undefined;
	targetHome: string;
	baseHome: string;
}

/** Where `/space switch <name>` goes. "base" is the home Pi used before the first switch. */
export function resolveSwitch(input: { dir: string; name: string; currentHome: string; env: Env }): SwitchTarget {
	const { dir, name, currentHome, env } = input;
	const current = activeSpace(dir, currentHome);
	const baseHome = env.PI_SPACES_BASE_HOME || (current === undefined ? resolve(currentHome) : undefined);
	if (name === BASE) {
		if (baseHome === undefined) throw new SpaceError("The base home is unknown in this session; start Pi without a space.");
		if (resolve(currentHome) === resolve(baseHome)) throw new SpaceError("Already in the base home.");
		return { space: undefined, targetHome: baseHome, baseHome };
	}
	const error = validateName(name);
	if (error) throw new SpaceError(error);
	if (!listSpaces(dir).includes(name)) throw new SpaceError(`Space "${name}" does not exist.`);
	if (current === name) throw new SpaceError(`Already in space "${name}".`);
	if (baseHome === undefined) throw new SpaceError("The base home is unknown in this session; start Pi without a space.");
	return { space: name, targetHome: join(dir, name), baseHome };
}

// PWD and OLDPWD describe the working directory, which the relaunch keeps.
const NOT_REWRITTEN = new Set(["PI_SPACES_DIR", "PI_SPACES_BASE_HOME", "PWD", "OLDPWD"]);

/**
 * The environment for the relaunched Pi. Every variable whose value is the current home,
 * or a path inside it, moves to the same path in the target home, so variables a host
 * set from the home stay consistent without this package knowing the host.
 */
export function relaunchEnv(env: Env, target: SwitchTarget & { currentHome: string }): Env {
	const from = resolve(target.currentHome);
	const next: Env = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const move = (part: string) => (part === from || part.startsWith(from + sep) ? target.targetHome + part.slice(from.length) : part);
		// Each entry of a list such as PATH moves on its own.
		next[key] = NOT_REWRITTEN.has(key) ? value : value.split(delimiter).map(move).join(delimiter);
	}
	next.PI_CODING_AGENT_DIR = target.targetHome;
	next.PI_SPACES_BASE_HOME = target.baseHome;
	if (target.space === undefined) delete next.PI_SPACE;
	else next.PI_SPACE = target.space;
	return next;
}

export interface Command {
	command: string;
	args: string[];
}

export interface Proc {
	execPath: string;
	execArgv: string[];
	argv: string[];
}

/** The same runtime and entry script that started this process, with the given Pi arguments (filtered by default). */
export function relaunchCommand(proc: Proc = process, args: string[] = filterArgs(proc.argv.slice(2))): Command {
	const script = proc.argv[1];
	// A single-file executable carries its entry inside itself.
	const embedded = script === undefined || script.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/.test(script);
	return { command: proc.execPath, args: [...proc.execArgv, ...(embedded ? [] : [script]), ...args] };
}

const SPACE_FLAG_ERROR = "--space needs a space name: pi --space <name>.";

/**
 * Finds --space <name> or --space=<name> before "--", and returns the other arguments unchanged,
 * and the arguments that follow the name.
 */
export function parseSpaceFlag(args: string[]): { name: string | undefined; rest: string[]; afterName: string[] } | { error: string } {
	const rest: string[] = [];
	let name: string | undefined;
	let afterName: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			rest.push(...args.slice(i));
			break;
		}
		if (arg === "--space") {
			const value = args[i + 1];
			if (value === undefined || value === "" || value.startsWith("-")) return { error: SPACE_FLAG_ERROR };
			name = value;
			i++;
			afterName = args.slice(i + 1);
		} else if (arg.startsWith("--space=")) {
			name = arg.slice("--space=".length);
			if (name === "") return { error: SPACE_FLAG_ERROR };
			afterName = args.slice(i + 1);
		} else {
			rest.push(arg);
		}
	}
	return { name, rest, afterName };
}

// Pi runs these only as its first argument, before extensions load.
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list"]);

export type StartupPlan = { kind: "none" } | { kind: "error"; message: string } | { kind: "relaunch"; command: Command; env: Env };

/**
 * What `pi --space <name>` does at startup: nothing without the flag or when Pi already runs in that
 * space; otherwise run Pi again in the space with every other argument, since nothing has run yet.
 * `pi --space <name> <package command> ...` always runs Pi again, even in the current home, because
 * Pi runs a package command (install, remove, uninstall, update, list) only as its first argument.
 */
export function planStartup(input: { proc: Proc; dir: string; currentHome: string; env: Env }): StartupPlan {
	const { proc, dir, currentHome, env } = input;
	const parsed = parseSpaceFlag(proc.argv.slice(2));
	if ("error" in parsed) return { kind: "error", message: parsed.error };
	if (parsed.name === undefined) return { kind: "none" };
	// A package command runs alone: options before --space (a launcher may add its own) are for a session.
	const packageCommand = PACKAGE_COMMANDS.has(parsed.afterName[0] ?? "");
	const args = packageCommand ? parsed.afterName : parsed.rest;
	let target: SwitchTarget;
	try {
		target = resolveSwitch({ dir, name: parsed.name, currentHome, env });
	} catch (error) {
		if (!(error instanceof SpaceError)) throw error;
		if (error.message.startsWith("Already in")) {
			return packageCommand ? { kind: "relaunch", command: relaunchCommand(proc, args), env } : { kind: "none" };
		}
		return { kind: "error", message: error.message };
	}
	return { kind: "relaunch", command: relaunchCommand(proc, args), env: relaunchEnv(env, { ...target, currentHome }) };
}

/** Runs the command now with inherited stdio and returns its exit code (1 when it cannot start). */
export function runNow(command: Command, env: Env): number {
	const result = spawnSync(command.command, command.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
	if (result.error) {
		process.stderr.write(`pi-spaces: could not start Pi again: ${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

/**
 * Runs the command with inherited stdio once this process exits (after Pi has
 * restored the terminal), then exits with the command's code.
 */
export function scheduleRelaunch(command: Command, env: Env): void {
	process.once("exit", () => {
		process.exitCode = runNow(command, env);
	});
}
