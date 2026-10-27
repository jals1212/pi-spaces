// pi-spaces: named Pi agent homes. Adds /space and shows the active space in the status line.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { completeSpaceArgs, runSpaceCommand, statusText } from "../src/command.ts";
import { planStartup, relaunchCommand, runNow, scheduleRelaunch } from "../src/relaunch.ts";
import { findOwnDeclaration, spacesDir } from "../src/spaces.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageName: string = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;

export default function (pi: ExtensionAPI) {
	// `pi --space <name>` is handled here, before the terminal UI starts and before any prompt runs:
	// Pi runs again in the space with every other argument, and this process exits with its code.
	const plan = planStartup({ proc: process, dir: spacesDir(), currentHome: getAgentDir(), env: process.env });
	if (plan.kind === "error") {
		process.stderr.write(`pi-spaces: ${plan.message}\n`);
		process.exit(1);
	}
	if (plan.kind === "relaunch") process.exit(runNow(plan.command, plan.env));

	pi.registerFlag("space", { description: "Start Pi in this space (see /space list)", type: "string" });

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("space", statusText(spacesDir(), getAgentDir()));
	});

	pi.registerCommand("space", {
		description: "Pick a Pi space to switch to, or list, create, remove and rename spaces (separate agent homes)",
		getArgumentCompletions: (prefix) => completeSpaceArgs(prefix, spacesDir()),
		handler: async (args, ctx) => {
			// Without a UI (print and JSON modes) notifications go nowhere, so they go to stderr;
			// stdout stays free for Pi's own output.
			const notify = ctx.hasUI
				? ctx.ui.notify.bind(ctx.ui)
				: (message: string) => void process.stderr.write(`${message}\n`);
			await runSpaceCommand(args, {
				ctx: { mode: ctx.mode, hasUI: ctx.hasUI, shutdown: () => ctx.shutdown(), ui: { notify, confirm: (t, m) => ctx.ui.confirm(t, m), select: (t, o) => ctx.ui.select(t, o) } },
				dir: spacesDir(),
				currentHome: getAgentDir,
				env: process.env,
				declaration: () => findOwnDeclaration(getAgentDir(), packageName, packageRoot),
				command: () => relaunchCommand(),
				relaunch: scheduleRelaunch,
			});
		},
	});
}
