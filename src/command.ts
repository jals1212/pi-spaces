// The /space command, kept apart from Pi's extension API so it can be tested directly.
import { join } from "node:path";
import { type Command, relaunchEnv, resolveSwitch } from "./relaunch.ts";
import {
	activeSpace,
	BACKUPS,
	BASE,
	backupSpace,
	checkRemovable,
	createSpace,
	type Env,
	listSpaces,
	type PackageDeclaration,
	removeSpace,
	renameSpace,
	SpaceError,
} from "./spaces.ts";

export const USAGE = "Usage: /space [list | new <name> | remove <name> [--yes] [--no-backup] | rename <old> <new> | switch [<name>]]";
const KEEP_BACKUP = "Keep a backup";
const NO_BACKUP = "Delete without a backup";
const SUBCOMMANDS = ["list", "new", "remove", "rename", "switch"];

export interface SpaceCommandContext {
	mode: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string): Promise<boolean>;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
	shutdown(): void;
}

export interface SpaceCommandDeps {
	ctx: SpaceCommandContext;
	/** The spaces folder. */
	dir: string;
	/** The agent home this Pi process runs with. */
	currentHome(): string;
	env: Env;
	/** This package's declaration for a new space's settings.json. */
	declaration(): PackageDeclaration;
	/** The command that starts this Pi process again. */
	command(): Command;
	relaunch(command: Command, env: Env): void;
}

export async function runSpaceCommand(args: string, deps: SpaceCommandDeps): Promise<void> {
	const { ctx } = deps;
	const words = args.trim().split(/\s+/).filter(Boolean);
	// Bare /space opens the switch picker in the terminal UI (one Enter from the command menu); elsewhere it lists.
	const [sub = ctx.mode === "tui" ? "switch" : "list", ...rest] = words;
	try {
		if (sub === "list" && rest.length === 0) return list(deps);
		if (sub === "new" && rest.length === 1) {
			const path = createSpace(deps.dir, rest[0], deps.declaration());
			ctx.ui.notify(`Created space "${rest[0]}" at ${path}. Enter it with /space switch ${rest[0]}.`, "info");
			return;
		}
		const removal = sub === "remove" ? parseRemove(rest) : undefined;
		if (removal) return await remove(removal, deps);
		if (sub === "rename" && rest.length === 2) {
			renameSpace(deps.dir, rest[0], rest[1], deps.currentHome(), protectedHomes(deps));
			ctx.ui.notify(`Renamed space "${rest[0]}" to "${rest[1]}".`, "info");
			return;
		}
		if (sub === "switch" && rest.length === 0) return await pickAndSwitch(deps);
		if (sub === "switch" && rest.length === 1) return switchTo(rest[0], deps);
		ctx.ui.notify(USAGE, "error");
	} catch (error) {
		if (!(error instanceof SpaceError)) throw error;
		ctx.ui.notify(error.message, "error");
	}
}

function list(deps: SpaceCommandDeps): void {
	const spaces = listSpaces(deps.dir);
	const active = activeSpace(deps.dir, deps.currentHome());
	const line = (name: string, isActive: boolean) => `${isActive ? "*" : " "} ${name}`;
	const lines = [`Spaces in ${deps.dir}:`, line(BASE, active === undefined), ...spaces.map((name) => line(name, name === active))];
	if (spaces.length === 0) lines.push("No spaces yet. Create one with /space new <name>.");
	deps.ctx.ui.notify(lines.join("\n"), "info");
}

interface Removal {
	name: string;
	yes: boolean;
	backup: boolean;
}

/** remove <name> with --yes and --no-backup after it, each at most once, in any order. */
function parseRemove(rest: string[]): Removal | undefined {
	const [name, ...flags] = rest;
	if (name === undefined || name.startsWith("-")) return undefined;
	if (flags.some((flag) => flag !== "--yes" && flag !== "--no-backup") || new Set(flags).size !== flags.length) return undefined;
	return { name, yes: flags.includes("--yes"), backup: !flags.includes("--no-backup") };
}

/** Without --yes it asks to remove, then (without --no-backup) whether to keep a backup, keeping one first in the list. */
async function remove({ name, yes, backup }: Removal, deps: SpaceCommandDeps): Promise<void> {
	const { ctx } = deps;
	let keep = backup;
	if (!yes) {
		if (!ctx.hasUI) throw new SpaceError(`Removing a space needs confirmation; run /space remove ${name} --yes.`);
		// Fail before asking when the space cannot be removed anyway.
		checkRemovable(deps.dir, name, deps.currentHome(), protectedHomes(deps));
		const ok = await ctx.ui.confirm(
			`Remove space "${name}"?`,
			`This deletes ${join(deps.dir, name)} and everything in it: sign-ins, packages, settings and sessions.`,
		);
		const choice = ok && backup ? await ctx.ui.select(`Keep a backup of "${name}" in ${join(deps.dir, BACKUPS)}?`, [KEEP_BACKUP, NO_BACKUP]) : undefined;
		// Dismissing the backup question is not an answer to it, so nothing is removed.
		if (!ok || (backup && choice === undefined)) {
			ctx.ui.notify(`Kept space "${name}".`, "info");
			return;
		}
		keep = backup && choice === KEEP_BACKUP;
	}
	if (keep) {
		const path = backupSpace(deps.dir, name, deps.currentHome(), protectedHomes(deps));
		ctx.ui.notify(`Removed space "${name}"; its backup is ${path}.`, "info");
		return;
	}
	removeSpace(deps.dir, name, deps.currentHome(), protectedHomes(deps));
	ctx.ui.notify(`Removed space "${name}".`, "info");
}

function protectedHomes(deps: SpaceCommandDeps): string[] {
	return deps.env.PI_SPACES_BASE_HOME ? [deps.env.PI_SPACES_BASE_HOME] : [];
}

async function pickAndSwitch(deps: SpaceCommandDeps): Promise<void> {
	const { ctx } = deps;
	if (ctx.mode !== "tui") throw new SpaceError("/space switch needs the interactive terminal.");
	const active = activeSpace(deps.dir, deps.currentHome());
	const options = [BASE, ...listSpaces(deps.dir)].filter((name) => (active === undefined ? name !== BASE : name !== active));
	if (options.length === 0) throw new SpaceError("No other space to switch to. Create one with /space new <name>.");
	const picked = await ctx.ui.select("Switch to space", options);
	if (picked === undefined) return;
	switchTo(picked, deps);
}

function switchTo(name: string, deps: SpaceCommandDeps): void {
	const { ctx } = deps;
	if (ctx.mode !== "tui") throw new SpaceError("/space switch needs the interactive terminal.");
	const currentHome = deps.currentHome();
	const target = resolveSwitch({ dir: deps.dir, name, currentHome, env: deps.env });
	deps.relaunch(deps.command(), relaunchEnv(deps.env, { ...target, currentHome }));
	ctx.ui.notify(
		target.space === undefined ? "Switching to the base home; Pi restarts in it." : `Switching to space "${target.space}"; Pi restarts in it.`,
		"info",
	);
	ctx.shutdown();
}

/** Status line text: the active space, or nothing in the base home. */
export function statusText(dir: string, currentHome: string): string | undefined {
	const active = activeSpace(dir, currentHome);
	return active === undefined ? undefined : `space: ${active}`;
}

export function completeSpaceArgs(prefix: string, dir: string): { value: string; label: string }[] | null {
	const words = prefix.split(" ");
	if (words.length === 1) {
		const items = SUBCOMMANDS.filter((sub) => sub.startsWith(words[0])).map((sub) => ({ value: sub, label: sub }));
		return items.length > 0 ? items : null;
	}
	if (words.length !== 2 || (words[0] !== "remove" && words[0] !== "rename" && words[0] !== "switch")) return null;
	const names = words[0] === "switch" ? [BASE, ...listSpaces(dir)] : listSpaces(dir);
	const items = names.filter((name) => name.startsWith(words[1])).map((name) => ({ value: `${words[0]} ${name}`, label: name }));
	return items.length > 0 ? items : null;
}
