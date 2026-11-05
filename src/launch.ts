// The command a switch runs for a profile with `commands`: the profile's own base or space command, filled in.
// Internal module: pure functions only, nothing here starts a process.
import type { Profile } from "./config.ts";
import { BASE } from "./spaces.ts";

export interface LaunchCommand {
	command: string;
	args: string[];
}

/** Where a switch goes: a space (with its home), or the base home when `space` is undefined. */
export interface LaunchTarget {
	space: string | undefined;
	targetHome: string;
	baseHome: string;
}

/**
 * The command that starts `target` for a profile with `commands`, or undefined when the profile has none (a v1
 * profile, or no profile), so the caller keeps its own relaunch:
 * - base: `commands.base`, with {home} and {name} filled with the base home and "base";
 * - a space: `commands.space` filled with the space's home and name, else `<commands.base> --space <name>`.
 * Throws an Error when the command has an unclosed quote.
 */
export function profileCommand(profile: Profile | undefined, target: LaunchTarget): LaunchCommand | undefined {
	const commands = profile?.commands;
	if (commands === undefined) return undefined;
	if (target.space === undefined) return toCommand(setupCommand(commands.base, target.baseHome, BASE));
	if (commands.space !== undefined) return toCommand(setupCommand(commands.space, target.targetHome, target.space));
	const { program, args } = setupCommand(commands.base, target.baseHome, BASE);
	return toCommand({ program, args: [...args, "--space", target.space] });
}

function toCommand({ program, args }: { program: string; args: string[] }): LaunchCommand {
	return { command: program, args };
}

/**
 * The program and arguments of a command template: split like a shell line (see splitCommand), with every {home}
 * and {name} in each word replaced. Throws when it has an unclosed quote.
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
