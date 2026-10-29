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

export function spaceInfo(dir: string, agentHome: string, env: Env): SpaceInfo {
	return {
		space: activeSpace(dir, agentHome),
		home: resolve(agentHome),
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
	return [
		info.space === undefined ? "This Pi runs in the base home, outside any space." : `This Pi runs in the space "${info.space}" (PI_SPACE).`,
		`Agent home: ${info.home} (PI_SPACE_HOME).`,
		`Command that starts Pi: ${info.command} (PI_SPACES_COMMAND); \`${info.command} --space <name>\` starts it in a space, and \`/space\` lists, creates, removes and switches spaces.`,
	].join("\n");
}
