// Relaunch: Pi reads its agent home once at startup, so entering a space means
// running the same Pi command again with PI_CODING_AGENT_DIR pointing at the space.
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { activeSpace, BASE, listSpaces, type Env, SpaceError, validateName } from "./spaces.ts";

// Pi options that take a separate value, so the value is kept (or dropped) with them.
const VALUE_OPTIONS = new Set([
	"--provider", "--model", "--api-key", "--thinking", "--models", "--mode", "--export",
	"-t", "--tools", "-xt", "--exclude-tools",
	"-e", "--extension", "--skill", "--prompt-template", "--theme", "--use-theme",
	"--system-prompt", "--append-system-prompt", "--tui-mode",
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
		if (VALUE_OPTIONS.has(name) && !inlineValue && i + 1 < args.length) kept.push(args[++i]);
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

const NOT_REWRITTEN = new Set(["PI_SPACES_DIR", "PI_SPACES_BASE_HOME"]);

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
		if (!NOT_REWRITTEN.has(key) && (value === from || value.startsWith(from + sep))) {
			next[key] = target.targetHome + value.slice(from.length);
		} else {
			next[key] = value;
		}
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

/** The same runtime and entry script that started this process, with the filtered arguments. */
export function relaunchCommand(proc: { execPath: string; execArgv: string[]; argv: string[] } = process): Command {
	const script = proc.argv[1];
	// A single-file executable carries its entry inside itself.
	const embedded = script === undefined || script.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/.test(script);
	return {
		command: proc.execPath,
		args: [...proc.execArgv, ...(embedded ? [] : [script]), ...filterArgs(proc.argv.slice(2))],
	};
}

/**
 * Runs the command with inherited stdio once this process exits (after Pi has
 * restored the terminal), then exits with the command's code.
 */
export function scheduleRelaunch(command: Command, env: Env): void {
	process.once("exit", () => {
		const result = spawnSync(command.command, command.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
		if (result.error) {
			process.stderr.write(`pi-spaces: could not start Pi again: ${result.error.message}\n`);
			process.exitCode = 1;
			return;
		}
		process.exitCode = result.status ?? 1;
	});
}
