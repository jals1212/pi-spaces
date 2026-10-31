// pi-spaces: named Pi agent homes. Adds /space and shows the active space in the status line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { completeSpaceArgs, runSpaceCommand, statusText } from "../src/command.ts";
import { activeProfile } from "../src/config.ts";
import { addSpaceSection, exportSpaceInfo, spaceInfo } from "../src/context.ts";
import { planStartup, relaunchCommand, runNow, scheduleRelaunch } from "../src/relaunch.ts";
import { findOwnDeclaration, spacesDir } from "../src/spaces.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageName: string = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;

export default function (pi: ExtensionAPI) {
	// The profile of the config file that describes this Pi's base home, if any. A file that cannot be used never
	// stops Pi: it is reported once, at session start, and Pi behaves as with no file.
	const { profile, warning } = activeProfile(process.env, homedir(), getAgentDir());
	let warned = false;
	const dir = spacesDir(process.env, homedir(), profile?.dir);

	// `pi --space <name>` is handled here, before the terminal UI starts and before any prompt runs:
	// Pi runs again in the space with every other argument, and this process exits with its code.
	const plan = planStartup({ proc: process, dir, currentHome: getAgentDir(), env: process.env, spaceEnv: profile?.spaceEnv });
	if (plan.kind === "error") {
		process.stderr.write(`pi-spaces: ${plan.message}\n`);
		process.exit(1);
	}
	if (plan.kind === "relaunch") process.exit(runNow(plan.command, plan.env));

	// Where this Pi runs: exported for tools and the programs they start, and told to the model before each run.
	const info = spaceInfo(dir, getAgentDir(), process.env);
	exportSpaceInfo(process.env, info);
	pi.on("before_agent_start", (event) => addSpaceSection(event.systemPromptOptions, info));

	pi.registerFlag("space", { description: "Start Pi in this space (see /space list)", type: "string" });

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("space", statusText(dir, getAgentDir()));
		if (warning !== undefined && !warned) {
			warned = true;
			if (ctx.hasUI) ctx.ui.notify(`pi-spaces: ${warning}`, "warning");
			else process.stderr.write(`pi-spaces: ${warning}\n`);
		}
	});

	pi.registerCommand("space", {
		description: "Pick a Pi space to switch to, or list, create, remove and rename spaces (separate agent homes)",
		getArgumentCompletions: (prefix) => completeSpaceArgs(prefix, dir),
		handler: async (args, ctx) => {
			// Without a UI (print and JSON modes) notifications go nowhere, so they go to stderr;
			// stdout stays free for Pi's own output.
			const notify = ctx.hasUI
				? ctx.ui.notify.bind(ctx.ui)
				: (message: string) => void process.stderr.write(`${message}\n`);
			await runSpaceCommand(args, {
				ctx: { mode: ctx.mode, hasUI: ctx.hasUI, shutdown: () => ctx.shutdown(), ui: { notify, confirm: (t, m) => ctx.ui.confirm(t, m), select: (t, o) => ctx.ui.select(t, o) } },
				dir,
				currentHome: getAgentDir,
				env: process.env,
				profile,
				declaration: () => findOwnDeclaration(getAgentDir(), packageName, packageRoot),
				command: () => relaunchCommand(),
				relaunch: scheduleRelaunch,
			});
		},
	});
}
