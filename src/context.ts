// What this Pi process knows about its space: the active space, the agent home and the command
// that starts Pi. It is exported to the environment (for tools and child processes) and told to the model.
import { resolve } from "node:path";
import { activeSpace, type Env } from "./spaces.ts";

export interface SpaceInfo {
	/** The active space, or undefined in the base home. */
	space: string | undefined;
	/** The agent home this Pi runs with. */
	home: string;
	/** PI_SPACES_COMMAND, the program that starts Pi (default pi). */
	command: string;
}

/**
 * Read once, when the extension loads: Pi keeps its agent home for the whole process, and
 * the active space cannot be renamed or removed, so the facts hold until Pi exits.
 */
export function spaceInfo(dir: string, agentHome: string, env: Env): SpaceInfo {
	return {
		space: activeSpace(dir, agentHome),
		home: resolve(agentHome),
		// A blank value counts as unset, so the default is pi (pi-space leaves it unset for a profile without a command).
		command: env.PI_SPACES_COMMAND?.trim() || "pi",
	};
}

/** Sets PI_SPACE (removed in the base home), PI_SPACE_HOME and PI_SPACES_COMMAND. */
export function exportSpaceInfo(env: Env, info: SpaceInfo): void {
	if (info.space === undefined) delete env.PI_SPACE;
	else env.PI_SPACE = info.space;
	env.PI_SPACE_HOME = info.home;
	env.PI_SPACES_COMMAND = info.command;
}

/** The system prompt section that tells the model where it runs. */
export function spacePrompt(info: SpaceInfo): string {
	const where = info.space === undefined
		? "This Pi runs in the base home, outside any space."
		: `This Pi runs in the space "${info.space}" (PI_SPACE).`;
	const home = `Agent home: ${info.home} (PI_SPACE_HOME).`;
	const start = `\`${info.command} --space <name>\` starts it in a space`;
	const manage = "`/space` lists, creates, removes and switches spaces";
	const command = `Command that starts Pi: ${info.command} (PI_SPACES_COMMAND); ${start}, and ${manage}.`;
	return [where, home, command].join("\n");
}

/** The part of a run's structured prompt options this package writes. */
export interface PromptSections {
	sections?: Record<string, string>;
}

/**
 * Sets the <pi_space> section in a run's structured prompt options, creating the section map when
 * it is missing and replacing an earlier pi_space section. Other sections and the rest of the
 * prompt are left alone. Without structured options (an older Pi) nothing is added; the
 * environment still has the facts.
 */
export function addSpaceSection(options: PromptSections | undefined, info: SpaceInfo): void {
	if (options === undefined) return;
	options.sections ??= {};
	options.sections.pi_space = spacePrompt(info);
}
