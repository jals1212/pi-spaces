import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { completeSpaceArgs, runSpaceCommand, statusText, USAGE, type SpaceCommandDeps } from "../src/command.ts";
import { BACKUPS, createSpace, spaceHome } from "../src/spaces.ts";

interface Fake {
	deps: SpaceCommandDeps;
	notes: [string, string][];
	confirms: string[];
	selects: [string, string[]][];
	relaunches: { command: unknown; env: Record<string, string | undefined> }[];
	shutdowns: number;
	dir: string;
	base: string;
}

function fake(options: { mode?: "tui" | "print"; hasUI?: boolean; confirm?: boolean; select?: (options: string[]) => string | undefined; home?: (dir: string, base: string) => string; cwd?: (root: string) => string; userHome?: (root: string) => string } = {}): Fake {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const dir = join(root, "spaces");
	const base = join(root, "agent");
	mkdirSync(base);
	const f: Fake = { notes: [], confirms: [], selects: [], relaunches: [], shutdowns: 0, dir, base, deps: undefined as never };
	f.deps = {
		ctx: {
			mode: options.mode ?? "tui",
			hasUI: options.hasUI ?? true,
			ui: {
				notify: (message, type = "info") => void f.notes.push([type, message]),
				confirm: async (title, message) => {
					f.confirms.push(`${title} | ${message}`);
					return options.confirm ?? true;
				},
				select: async (title, choices) => {
					f.selects.push([title, choices]);
					return options.select?.(choices);
				},
			},
			shutdown: () => void f.shutdowns++,
		},
		dir,
		currentHome: () => (options.home ? options.home(dir, base) : base),
		env: { PI_CODING_AGENT_DIR: base },
		declaration: () => "npm:pi-spaces",
		command: () => ({ command: "/n/node", args: ["/p/cli.js"] }),
		relaunch: (command, env) => void f.relaunches.push({ command, env }),
		cwd: () => (options.cwd ? options.cwd(root) : join(root, "project")),
		userHome: options.userHome ? options.userHome(root) : join(root, "user"),
	};
	return f;
}

test("list shows base and every space, marking the active one", async () => {
	const f = fake();
	await runSpaceCommand("list", f.deps);
	assert.deepEqual(f.notes, [["info", `Spaces in ${f.dir}:\n* base\nNo spaces yet. Create one with /space new <name>.`]]);

	createSpace(f.dir, "work", "x");
	createSpace(f.dir, "alpha", "x");
	f.notes.length = 0;
	await runSpaceCommand("list", f.deps);
	assert.deepEqual(f.notes, [["info", `Spaces in ${f.dir}:\n* base\n  alpha\n  work`]]);

	const h = fake({ home: (dir) => join(dir, "work", "agent") });
	createSpace(h.dir, "work", "x");
	await runSpaceCommand("list", h.deps);
	assert.deepEqual(h.notes, [["info", `Spaces in ${h.dir}:\n  base\n* work`]]);
});

test("new creates the space with this package's declaration", async () => {
	const f = fake();
	await runSpaceCommand("new work", f.deps);
	assert.deepEqual(f.notes, [["info", `Created space "work" at ${join(f.dir, "work")}. Enter it with /space switch work.`]]);
	assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "work", "agent", "settings.json"), "utf8")), { packages: ["npm:pi-spaces"] });

	f.notes.length = 0;
	await runSpaceCommand("new work", f.deps);
	await runSpaceCommand("new Bad", f.deps);
	assert.deepEqual(f.notes, [
		["error", 'Space "work" already exists.'],
		["error", 'Invalid space name "Bad": use lowercase letters, digits, "-" and "_", starting with a letter or digit (at most 64 characters).'],
	]);
	assert.equal(existsSync(join(f.dir, "Bad")), false);
});

test("old flat spaces still list, switch and show as active; a rooted one is entered at its agent home with {space} filled", async () => {
	const f = fake({ home: (dir) => join(dir, "old") });
	mkdirSync(join(f.dir, "old"), { recursive: true });
	createSpace(f.dir, "fresh", "x");
	await runSpaceCommand("list", f.deps);
	assert.deepEqual(f.notes, [["info", `Spaces in ${f.dir}:\n  base\n  fresh\n* old`]]);
	assert.equal(statusText(f.dir, join(f.dir, "old"), "pi", { argv: ["n", "p"] }, {}), "🪐 pi/old");
	assert.equal(spaceHome(join(f.dir, "fresh")), join(f.dir, "fresh", "agent"));

	f.deps.profile = { name: "launcher", home: f.base, dir: f.dir, spaceEnv: { ROOT: "{space}", HOME_DIR: "{home}" } };
	f.deps.env = { PI_CODING_AGENT_DIR: join(f.dir, "old"), PI_SPACES_BASE_HOME: f.base, PI_SPACE: "old" };
	await runSpaceCommand("switch fresh", f.deps);
	const entered = f.relaunches[0].env;
	assert.equal(entered.PI_CODING_AGENT_DIR, join(f.dir, "fresh", "agent"));
	assert.equal(entered.ROOT, join(f.dir, "fresh"));
	assert.equal(entered.HOME_DIR, join(f.dir, "fresh", "agent"));

	// A flat target: the root is the home.
	const g = fake();
	mkdirSync(join(g.dir, "old"), { recursive: true });
	g.deps.profile = { name: "launcher", home: g.base, dir: g.dir, spaceEnv: { ROOT: "{space}" } };
	await runSpaceCommand("switch old", g.deps);
	assert.equal(g.relaunches[0].env.PI_CODING_AGENT_DIR, join(g.dir, "old"));
	assert.equal(g.relaunches[0].env.ROOT, join(g.dir, "old"));
});

test("switch with a command template fills {space} with the root of a rooted space", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	f.deps.profile = { name: "ml", home: f.base, dir: f.dir, commands: { base: "my-launcher", space: "my-launcher --home {home} --root {space}" } };
	await runSpaceCommand("switch work", f.deps);
	assert.deepEqual(f.relaunches[0].command, { command: "my-launcher", args: ["--home", join(f.dir, "work", "agent"), "--root", join(f.dir, "work")] });
});

test("new names pi-space setup when PI_SPACES_SETUP is set, and runs nothing", async () => {
	const f = fake();
	f.deps.env.PI_SPACES_SETUP = "my-launcher --home {home} setup";
	await runSpaceCommand("new work", f.deps);
	assert.deepEqual(f.notes, [
		["info", `Created space "work" at ${join(f.dir, "work")}. Prepare it from a shell with: pi-space setup pi/work. Then enter it with /space switch work.`],
	]);
	assert.equal(f.relaunches.length, 0);

	const blank = fake();
	blank.deps.env.PI_SPACES_SETUP = "  ";
	await runSpaceCommand("new work", blank.deps);
	assert.deepEqual(blank.notes, [["info", `Created space "work" at ${join(blank.dir, "work")}. Enter it with /space switch work.`]]);
});

test("new names pi-space setup when the matched profile has a setup, and not otherwise", async () => {
	const prepared = (profile: string, name: string, dir: string) =>
		`Created space "${name}" at ${join(dir, name)}. Prepare it from a shell with: pi-space setup ${profile}/${name}. Then enter it with /space switch ${name}.`;
	const plain = (name: string, dir: string) => `Created space "${name}" at ${join(dir, name)}. Enter it with /space switch ${name}.`;

	const withSetup = fake();
	withSetup.deps.profile = { name: "launcher", home: withSetup.base, dir: withSetup.dir, setup: "my-launcher --home {home} setup" };
	await runSpaceCommand("new work", withSetup.deps);
	assert.deepEqual(withSetup.notes, [["info", prepared("launcher", "work", withSetup.dir)]]);
	assert.equal(withSetup.relaunches.length, 0);

	const without = fake();
	without.deps.profile = { name: "launcher", home: without.base, dir: without.dir, spaceEnv: { K: "{home}" } };
	await runSpaceCommand("new work", without.deps);
	assert.deepEqual(without.notes, [["info", plain("work", without.dir)]]);

	// PI_SPACES_SETUP still counts, with or without a profile.
	const viaEnv = fake();
	viaEnv.deps.env.PI_SPACES_SETUP = "my-launcher setup";
	viaEnv.deps.profile = { name: "pi", home: viaEnv.base, dir: viaEnv.dir, command: "pi" };
	await runSpaceCommand("new work", viaEnv.deps);
	assert.deepEqual(viaEnv.notes, [["info", prepared("pi", "work", viaEnv.dir)]]);
});

test("switch applies the profile's spaceEnv: set in a space, removed in base, recomputed between spaces", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	createSpace(f.dir, "play", "x");
	f.deps.profile = { name: "launcher", home: f.base, dir: f.dir, spaceEnv: { HOST_CFG: "{home}/cfg" } };
	await runSpaceCommand("switch work", f.deps);
	assert.deepEqual(f.relaunches[0].env, {
		PI_CODING_AGENT_DIR: join(f.dir, "work", "agent"),
		PI_SPACES_BASE_HOME: f.base,
		PI_SPACE: "work",
		HOST_CFG: `${join(f.dir, "work", "agent")}/cfg`,
		PI_SPACES_BASE_ENV: "{}",
	});

	const inWork = fake({ home: (dir) => join(dir, "work", "agent") });
	createSpace(inWork.dir, "work", "x");
	createSpace(inWork.dir, "play", "x");
	inWork.deps.profile = { name: "launcher", home: inWork.base, dir: inWork.dir, spaceEnv: { HOST_CFG: "{home}/cfg" } };
	inWork.deps.env = { PI_CODING_AGENT_DIR: join(inWork.dir, "work", "agent"), PI_SPACES_BASE_HOME: inWork.base, PI_SPACE: "work", HOST_CFG: join(inWork.dir, "work", "agent", "cfg") };
	await runSpaceCommand("switch play", inWork.deps);
	await runSpaceCommand("switch base", inWork.deps);
	assert.equal(inWork.relaunches[0].env.HOST_CFG, `${join(inWork.dir, "play", "agent")}/cfg`);
	assert.deepEqual(inWork.relaunches[1].env, { PI_CODING_AGENT_DIR: inWork.base, PI_SPACES_BASE_HOME: inWork.base });
});

const KEEP = "Keep a backup";
const DROP = "Delete without a backup";

/** The one backup left in the spaces folder, or undefined. */
function onlyBackup(dir: string): string | undefined {
	const folder = join(dir, BACKUPS);
	if (!existsSync(folder)) return undefined;
	const entries = readdirSync(folder);
	assert.equal(entries.length, 1);
	return join(folder, entries[0]);
}

test("remove asks first, and keeps the space when declined", async () => {
	const f = fake({ confirm: false });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work", f.deps);
	assert.deepEqual(f.confirms, [
		`Remove space "work"? | This deletes ${join(f.dir, "work")} and everything in it: sign-ins, packages, settings and sessions.`,
	]);
	assert.deepEqual(f.selects, []);
	assert.deepEqual(f.notes, [["info", 'Kept space "work".']]);
	assert.equal(existsSync(join(f.dir, "work")), true);
});

test("remove then asks about a backup, keeping one first in the list", async () => {
	const f = fake({ confirm: true, select: (choices) => choices[0] });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work", f.deps);
	assert.deepEqual(f.selects, [[`Keep a backup of "work" in ${join(f.dir, BACKUPS)}?`, [KEEP, DROP]]]);
	const backup = onlyBackup(f.dir);
	assert.ok(backup);
	assert.deepEqual(f.notes, [["info", `Removed space "work"; its backup is ${backup}.`]]);
	assert.equal(existsSync(join(f.dir, "work")), false);

	const g = fake({ confirm: true, select: () => DROP });
	createSpace(g.dir, "work", "x");
	await runSpaceCommand("remove work", g.deps);
	assert.deepEqual(g.notes, [["info", 'Removed space "work".']]);
	assert.equal(existsSync(join(g.dir, "work")), false);
	assert.equal(onlyBackup(g.dir), undefined);
});

test("remove keeps the space when the backup question is dismissed", async () => {
	const f = fake({ confirm: true, select: () => undefined });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work", f.deps);
	assert.deepEqual(f.notes, [["info", 'Kept space "work".']]);
	assert.equal(existsSync(join(f.dir, "work")), true);
	assert.equal(onlyBackup(f.dir), undefined);
});

test("remove --no-backup does not ask about a backup and deletes after the confirmation", async () => {
	const f = fake({ confirm: true, select: () => KEEP });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work --no-backup", f.deps);
	assert.equal(f.confirms.length, 1);
	assert.deepEqual(f.selects, []);
	assert.deepEqual(f.notes, [["info", 'Removed space "work".']]);
	assert.equal(onlyBackup(f.dir), undefined);
});

test("remove without a dialog needs --yes, and then keeps a backup unless --no-backup", async () => {
	const f = fake({ mode: "print", hasUI: false });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work", f.deps);
	assert.deepEqual(f.notes, [["error", 'Removing a space needs confirmation; run /space remove work --yes.']]);
	assert.equal(existsSync(join(f.dir, "work")), true);
	f.notes.length = 0;
	await runSpaceCommand("remove work --yes", f.deps);
	const backup = onlyBackup(f.dir);
	assert.ok(backup);
	assert.deepEqual(f.notes, [["info", `Removed space "work"; its backup is ${backup}.`]]);
	assert.deepEqual(f.confirms, []);
	assert.deepEqual(f.selects, []);

	const g = fake({ mode: "print", hasUI: false });
	createSpace(g.dir, "work", "x");
	await runSpaceCommand("remove work --no-backup --yes", g.deps);
	assert.deepEqual(g.notes, [["info", 'Removed space "work".']]);
	assert.equal(existsSync(join(g.dir, "work")), false);
	assert.equal(onlyBackup(g.dir), undefined);
});

test("remove reports a backup that cannot be written and keeps the space", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
	const f = fake({ mode: "print", hasUI: false });
	createSpace(f.dir, "work", "x");
	chmodSync(f.dir, 0o555);
	try {
		await runSpaceCommand("remove work --yes", f.deps);
	} finally {
		chmodSync(f.dir, 0o755);
	}
	assert.equal(f.notes.length, 1);
	assert.equal(f.notes[0][0], "error");
	assert.match(f.notes[0][1], /^Could not back up space "work": .*EACCES.*\. The space was not removed; fix that, or remove it without a backup with --no-backup\.$/);
	assert.equal(existsSync(join(f.dir, "work", "agent", "settings.json")), true);
	assert.equal(existsSync(join(f.dir, BACKUPS)), false);
});

test("remove with an unknown or repeated flag prints the usage and keeps the space", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	for (const args of ["remove work --backup", "remove work --yes --yes", "remove work --no-backup --no-backup", "remove --yes"]) {
		await runSpaceCommand(args, f.deps);
	}
	assert.deepEqual(f.notes, Array(4).fill(["error", USAGE]));
	assert.equal(existsSync(join(f.dir, "work")), true);
});

test("remove refuses the active space and missing names before asking", async () => {
	const f = fake({ home: (dir) => join(dir, "work", "agent") });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work --yes", f.deps);
	await runSpaceCommand("remove work", f.deps);
	await runSpaceCommand("remove ghost", f.deps);
	assert.deepEqual(f.notes, [
		["error", 'Space "work" is active; switch to another space before removing it.'],
		["error", 'Space "work" is active; switch to another space before removing it.'],
		["error", 'Space "ghost" does not exist.'],
	]);
	assert.deepEqual(f.confirms, []);
	assert.equal(existsSync(join(f.dir, "work")), true);
});

test("switch schedules the relaunch with the space environment and shuts Pi down", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("switch work", f.deps);
	assert.deepEqual(f.notes, [["info", 'Switching to space "work"; Pi restarts in it.']]);
	assert.equal(f.shutdowns, 1);
	assert.deepEqual(f.relaunches, [
		{
			command: { command: "/n/node", args: ["/p/cli.js"] },
			env: { PI_CODING_AGENT_DIR: join(f.dir, "work", "agent"), PI_SPACES_BASE_HOME: f.base, PI_SPACE: "work" },
		},
	]);
});

test("switch base goes back to the home Pi started with", async () => {
	const f = fake({ home: (dir) => join(dir, "work", "agent") });
	createSpace(f.dir, "work", "x");
	f.deps.env = { PI_CODING_AGENT_DIR: join(f.dir, "work", "agent"), PI_SPACES_BASE_HOME: f.base, PI_SPACE: "work" };
	await runSpaceCommand("switch base", f.deps);
	assert.deepEqual(f.notes, [["info", "Switching to the base home; Pi restarts in it."]]);
	assert.deepEqual(f.relaunches[0].env, { PI_CODING_AGENT_DIR: f.base, PI_SPACES_BASE_HOME: f.base });
});

const launcher = (commands: { base: string; space?: string }) => ({ name: "ml", home: "", dir: "", commands });

test("switch with a v2 profile runs commands.space for a space, with the same environment", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	f.deps.profile = { ...launcher({ base: "my-launcher", space: "my-launcher --home {home} --name {name}" }), home: f.base, dir: f.dir };
	await runSpaceCommand("switch work", f.deps);
	assert.deepEqual(f.relaunches, [
		{
			command: { command: "my-launcher", args: ["--home", join(f.dir, "work", "agent"), "--name", "work"] },
			env: { PI_CODING_AGENT_DIR: join(f.dir, "work", "agent"), PI_SPACES_BASE_HOME: f.base, PI_SPACE: "work" },
		},
	]);
	assert.equal(f.shutdowns, 1);
});

test("switch base with a v2 profile runs commands.base, with the same environment as before", async () => {
	const f = fake({ home: (dir) => join(dir, "work", "agent") });
	createSpace(f.dir, "work", "x");
	f.deps.env = { PI_CODING_AGENT_DIR: join(f.dir, "work", "agent"), PI_SPACES_BASE_HOME: f.base, PI_SPACE: "work" };
	f.deps.profile = { ...launcher({ base: "my-launcher --fast", space: "my-launcher --home {home}" }), home: f.base, dir: f.dir };
	await runSpaceCommand("switch base", f.deps);
	assert.deepEqual(f.relaunches, [
		{ command: { command: "my-launcher", args: ["--fast"] }, env: { PI_CODING_AGENT_DIR: f.base, PI_SPACES_BASE_HOME: f.base } },
	]);
	assert.equal(f.shutdowns, 1);
});

test("switch to a space with a v2 profile without commands.space runs <base> --space <name>", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	f.deps.profile = { ...launcher({ base: "my-launcher" }), home: f.base, dir: f.dir };
	await runSpaceCommand("switch work", f.deps);
	assert.deepEqual(f.relaunches[0].command, { command: "my-launcher", args: ["--space", "work"] });
});

test("switch with a profile without commands keeps relaunching this Pi", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	f.deps.profile = { name: "ml", home: f.base, dir: f.dir, command: "my-launcher --home {home}" };
	await runSpaceCommand("switch work", f.deps);
	assert.deepEqual(f.relaunches[0].command, { command: "/n/node", args: ["/p/cli.js"] });
	assert.equal(f.shutdowns, 1);
});

test("switch with an unclosed quote in the profile command notifies the error and relaunches nothing", async () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	f.deps.profile = { ...launcher({ base: "my-launcher", space: "my-launcher 'oops {name}" }), home: f.base, dir: f.dir };
	await runSpaceCommand("switch work", f.deps);
	assert.deepEqual(f.notes, [["error", "The command of profile ml cannot be used: the command has an unclosed ' quote."]]);
	assert.equal(f.relaunches.length, 0);
	assert.equal(f.shutdowns, 0);
});

test("switch refuses outside the terminal UI and for unknown spaces, without shutting down", async () => {
	const f = fake({ mode: "print", hasUI: false });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("switch work", f.deps);
	const g = fake();
	await runSpaceCommand("switch ghost", g.deps);
	assert.deepEqual(f.notes, [["error", "/space switch needs the interactive terminal."]]);
	assert.deepEqual(g.notes, [["error", 'Space "ghost" does not exist.']]);
	assert.equal(f.shutdowns + g.shutdowns, 0);
	assert.equal(f.relaunches.length + g.relaunches.length, 0);
});

test("rename moves the space and reports it", async () => {
	const f = fake();
	createSpace(f.dir, "a", "x");
	await runSpaceCommand("rename a b", f.deps);
	assert.deepEqual(f.notes, [["info", 'Renamed space "a" to "b".']]);
	assert.equal(existsSync(join(f.dir, "a")), false);
	assert.equal(existsSync(join(f.dir, "b", "agent", "settings.json")), true);
});

test("rename refuses base, the active space, a taken name and a space holding the base home", async () => {
	const f = fake({ home: (dir) => join(dir, "work", "agent") });
	createSpace(f.dir, "work", "x");
	createSpace(f.dir, "other", "x");
	await runSpaceCommand("rename base z", f.deps);
	await runSpaceCommand("rename other base", f.deps);
	await runSpaceCommand("rename work z", f.deps);
	await runSpaceCommand("rename other work", f.deps);
	await runSpaceCommand("rename ghost z", f.deps);
	f.deps.env = { ...f.deps.env, PI_SPACES_BASE_HOME: join(f.dir, "other") };
	await runSpaceCommand("rename other z", f.deps);
	assert.deepEqual(f.notes, [
		["error", '"base" is reserved for the home Pi started with.'],
		["error", '"base" is reserved for the home Pi started with.'],
		["error", 'Space "work" is active; switch to another space before renaming it.'],
		["error", 'Space "work" already exists.'],
		["error", 'Space "ghost" does not exist.'],
		["error", `Space "other" holds the base home ${join(f.dir, "other")}; it cannot be renamed.`],
	]);
	assert.equal(existsSync(join(f.dir, "z")), false);
	assert.equal(existsSync(join(f.dir, "other")), true);
});

test("switch without a name offers every space but the current one, and base unless Pi runs in it", async () => {
	const f = fake({ select: () => "work" });
	createSpace(f.dir, "work", "x");
	createSpace(f.dir, "alpha", "x");
	await runSpaceCommand("switch", f.deps);
	assert.deepEqual(f.selects, [["Switch to space", ["alpha", "work"]]]);
	assert.deepEqual(f.notes, [["info", 'Switching to space "work"; Pi restarts in it.']]);
	assert.equal(f.shutdowns, 1);
	assert.equal(f.relaunches[0].env.PI_CODING_AGENT_DIR, join(f.dir, "work", "agent"));
	assert.equal(f.relaunches[0].env.PI_SPACE, "work");

	const g = fake({ home: (dir) => join(dir, "work", "agent"), select: (choices) => choices[0] });
	createSpace(g.dir, "work", "x");
	createSpace(g.dir, "alpha", "x");
	g.deps.env = { PI_CODING_AGENT_DIR: join(g.dir, "work", "agent"), PI_SPACES_BASE_HOME: g.base, PI_SPACE: "work" };
	await runSpaceCommand("switch", g.deps);
	assert.deepEqual(g.selects, [["Switch to space", ["base", "alpha"]]]);
	assert.deepEqual(g.notes, [["info", "Switching to the base home; Pi restarts in it."]]);
	assert.deepEqual(g.relaunches[0].env, { PI_CODING_AGENT_DIR: g.base, PI_SPACES_BASE_HOME: g.base });
});

test("switch without a name offers only base when the current space is the only one", async () => {
	const f = fake({ home: (dir) => join(dir, "work", "agent"), select: () => undefined });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("switch", f.deps);
	assert.deepEqual(f.selects, [["Switch to space", ["base"]]]);
});

test("switch without a name does nothing when the picker is cancelled", async () => {
	const f = fake({ select: () => undefined });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("switch", f.deps);
	assert.equal(f.selects.length, 1);
	assert.deepEqual(f.notes, []);
	assert.equal(f.shutdowns, 0);
	assert.equal(f.relaunches.length, 0);
});

test("switch without a name and nothing to pick shows an error without opening the picker", async () => {
	const f = fake();
	await runSpaceCommand("switch", f.deps);
	assert.deepEqual(f.selects, []);
	assert.deepEqual(f.notes, [["error", "No other space to switch to. Create one with /space new <name>."]]);
	assert.equal(f.relaunches.length, 0);
});

test("switch without a name needs the interactive terminal", async () => {
	const f = fake({ mode: "print", hasUI: false, select: () => "work" });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("switch", f.deps);
	assert.deepEqual(f.notes, [["error", "/space switch needs the interactive terminal."]]);
	assert.deepEqual(f.selects, []);
	assert.equal(f.shutdowns, 0);
});

test("unknown subcommands and missing names show the usage", async () => {
	const f = fake();
	for (const args of ["nope", "new", "remove", "rename", "rename a", "rename a b c", "switch a b", "new a b"]) await runSpaceCommand(args, f.deps);
	assert.deepEqual(f.notes, Array(8).fill(["error", USAGE]));
	assert.equal(USAGE, "Usage: /space [list | new <name> | remove <name> [--yes] [--no-backup] | rename <old> <new> | switch [<name>] | pin | unpin]");
});

test("statusText names the active space as <profile>/<name>, and base only when pi-spaces opened it", () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	const proc = (args: string[]) => ({ argv: ["/n/node", "/p/cli.js", ...args] });
	const env = (vars: Record<string, string> = {}) => vars;
	// A space: always named, with the profile of this Pi, as pi-space names it.
	assert.equal(statusText(f.dir, join(f.dir, "work", "agent"), "pi", proc([]), env()), "🪐 pi/work");
	assert.equal(statusText(f.dir, join(f.dir, "work", "agent"), "launcher", proc([]), env()), "🪐 launcher/work");
	// The base home from plain pi: nothing.
	assert.equal(statusText(f.dir, f.base, "pi", proc([]), env()), undefined);
	assert.equal(statusText(f.dir, f.base, "pi", proc(["-c", "base"]), env()), undefined);
	// The base home through pi-spaces: pi --space base (pi-space pi/base), or a switch back to base.
	assert.equal(statusText(f.dir, f.base, "pi", proc(["--space", "base"]), env()), "🪐 pi/base");
	assert.equal(statusText(f.dir, f.base, "pi", proc(["-e", "/pkg", "--space=base"]), env()), "🪐 pi/base");
	assert.equal(statusText(f.dir, f.base, "launcher", proc([]), env({ PI_SPACES_BASE_HOME: f.base })), "🪐 launcher/base");
});

test("completeSpaceArgs completes subcommands, then space names", () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	createSpace(f.dir, "web", "x");
	const values = (prefix: string) => completeSpaceArgs(prefix, f.dir)?.map((item) => item.value) ?? null;
	assert.deepEqual(values(""), ["list", "new", "remove", "rename", "switch", "pin", "unpin"]);
	assert.deepEqual(values("re"), ["remove", "rename"]);
	assert.deepEqual(values("rename "), ["rename web", "rename work"]);
	assert.deepEqual(values("rename w"), ["rename web", "rename work"]);
	assert.deepEqual(values("rename web "), null);
	assert.deepEqual(values("s"), ["switch"]);
	assert.deepEqual(values("switch "), ["switch base", "switch web", "switch work"]);
	assert.deepEqual(values("remove w"), ["remove web", "remove work"]);
	assert.deepEqual(values("new "), null);
});

test("bare /space opens the switch picker in the terminal UI", async () => {
	const f = fake({ select: () => "work" });
	createSpace(f.dir, "work", "x");
	createSpace(f.dir, "web", "x");
	await runSpaceCommand("", f.deps);
	await runSpaceCommand("   ", f.deps);
	assert.deepEqual(f.selects, [
		["Switch to space", ["web", "work"]],
		["Switch to space", ["web", "work"]],
	]);
	assert.deepEqual(f.notes, [
		["info", 'Switching to space "work"; Pi restarts in it.'],
		["info", 'Switching to space "work"; Pi restarts in it.'],
	]);
	assert.equal(f.relaunches.length, 2);
	assert.equal(f.shutdowns, 2);
});

test("bare /space without the terminal UI lists the spaces", async () => {
	const f = fake({ mode: "print", hasUI: false });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("", f.deps);
	assert.deepEqual(f.notes, [["info", `Spaces in ${f.dir}:\n* base\n  work`]]);
	assert.deepEqual(f.selects, []);
	assert.equal(f.relaunches.length, 0);
});

// /space pin and /space unpin: only this Pi's own space, pinned to the repository of the session's folder.

const PIN_TEXT = "# pi-space: this folder is local to this machine; this file ignores all of it, itself included.\n*\n";

/** A git repository at <root>/project with a subfolder, the session's folder. */
function repo(root: string): string {
	const project = join(root, "project");
	mkdirSync(join(project, "src"), { recursive: true });
	assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
	return join(project, "src");
}

test("pin: /space pin in base pins <profile>/base in the repository root of the session's folder", async () => {
	const f = fake({ cwd: repo });
	await runSpaceCommand("pin", f.deps);
	const file = join(dirname(f.dir), "project", ".pi", "pi-space", "space");
	assert.deepEqual(f.notes, [["info", `Pinned pi/base in ${file}.`]]);
	assert.equal(readFileSync(file, "utf8"), "pi/base\n");
	assert.equal(readFileSync(join(dirname(file), ".gitignore"), "utf8"), PIN_TEXT);
});

test("pin: /space pin in a space pins that space with this Pi's profile, and names the one it replaces", async () => {
	const f = fake({ cwd: repo, home: (dir) => join(dir, "work", "agent") });
	createSpace(f.dir, "work", "x");
	f.deps.profile = { name: "gentle" } as SpaceCommandDeps["profile"];
	const file = join(dirname(f.dir), "project", ".pi", "pi-space", "space");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "pi/base\n");
	await runSpaceCommand("pin", f.deps);
	assert.deepEqual(f.notes, [["info", `Pinned gentle/work in ${file} (was pi/base).`]]);
	assert.equal(readFileSync(file, "utf8"), "gentle/work\n");
});

test("pin: /space pin takes no name, only the current space", async () => {
	const f = fake({ cwd: repo });
	await runSpaceCommand("pin pi/other", f.deps);
	assert.deepEqual(f.notes, [["error", USAGE]]);
	assert.equal(existsSync(join(dirname(f.dir), "project", ".pi")), false);
});

test("pin: /space pin refuses the home folder and writes nothing", async () => {
	const f = fake({ cwd: (root) => join(root, "user"), userHome: (root) => join(root, "user") });
	mkdirSync(join(dirname(f.dir), "user"));
	await runSpaceCommand("pin", f.deps);
	const home = join(dirname(f.dir), "user");
	assert.deepEqual(f.notes, [["error", `${home} is your home folder, where .pi is Pi's own folder; pin a space in a project folder.`]]);
	assert.equal(existsSync(join(home, ".pi")), false);
});

test("pin: /space unpin removes the marker, its .gitignore and the folders left empty; with none it says so", async () => {
	const f = fake({ cwd: repo });
	await runSpaceCommand("pin", f.deps);
	f.notes.length = 0;
	await runSpaceCommand("unpin", f.deps);
	const folder = join(dirname(f.dir), "project", ".pi", "pi-space");
	assert.deepEqual(f.notes, [["info", `Unpinned pi/base (removed ${folder}).`]]);
	assert.equal(existsSync(join(dirname(f.dir), "project", ".pi")), false);
	f.notes.length = 0;
	await runSpaceCommand("unpin", f.deps);
	assert.deepEqual(f.notes, [["info", `No space pinned in ${join(dirname(f.dir), "project")}.`]]);
	await runSpaceCommand("unpin now", f.deps);
	assert.deepEqual(f.notes.at(-1), ["error", USAGE]);
});

test("pin: completion offers pin and unpin, with nothing after them", () => {
	const f = fake();
	assert.deepEqual(completeSpaceArgs("p", f.dir), [{ value: "pin", label: "pin" }]);
	assert.deepEqual(completeSpaceArgs("u", f.dir), [{ value: "unpin", label: "unpin" }]);
	assert.equal(completeSpaceArgs("pin ", f.dir), null);
});
