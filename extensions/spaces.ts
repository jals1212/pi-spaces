// pi-spaces: named Pi agent homes. Adds /space and shows the active space in the status line.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { completeSpaceArgs, runSpaceCommand, statusText } from "../src/command.ts";
import { relaunchCommand, scheduleRelaunch } from "../src/relaunch.ts";
import { findOwnDeclaration, spacesDir } from "../src/spaces.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageName: string = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("space", statusText(spacesDir(), getAgentDir()));
	});

	pi.registerCommand("space", {
		description: "List, create, remove or switch Pi spaces (separate agent homes)",
		getArgumentCompletions: (prefix) => completeSpaceArgs(prefix, spacesDir()),
		handler: async (args, ctx) => {
			// Without a UI (print and JSON modes) notifications go nowhere, so they go to stderr;
			// stdout stays free for Pi's own output.
			const notify = ctx.hasUI
				? ctx.ui.notify.bind(ctx.ui)
				: (message: string) => void process.stderr.write(`${message}\n`);
			await runSpaceCommand(args, {
				ctx: { mode: ctx.mode, hasUI: ctx.hasUI, shutdown: () => ctx.shutdown(), ui: { notify, confirm: (t, m) => ctx.ui.confirm(t, m) } },
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
