import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { completeSpaceArgs, runSpaceCommand, statusText, USAGE, type SpaceCommandDeps } from "../src/command.ts";
import { createSpace } from "../src/spaces.ts";

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

function fake(options: { mode?: "tui" | "print"; hasUI?: boolean; confirm?: boolean; select?: (options: string[]) => string | undefined; home?: (dir: string, base: string) => string } = {}): Fake {
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
		declaration: () => "npm:@jals1212/pi-spaces",
		command: () => ({ command: "/n/node", args: ["/p/cli.js"] }),
		relaunch: (command, env) => void f.relaunches.push({ command, env }),
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

	const h = fake({ home: (dir) => join(dir, "work") });
	createSpace(h.dir, "work", "x");
	await runSpaceCommand("list", h.deps);
	assert.deepEqual(h.notes, [["info", `Spaces in ${h.dir}:\n  base\n* work`]]);
});

test("new creates the space with this package's declaration", async () => {
	const f = fake();
	await runSpaceCommand("new work", f.deps);
	assert.deepEqual(f.notes, [["info", `Created space "work" at ${join(f.dir, "work")}. Enter it with /space switch work.`]]);
	assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "work", "settings.json"), "utf8")), { packages: ["npm:@jals1212/pi-spaces"] });

	f.notes.length = 0;
	await runSpaceCommand("new work", f.deps);
	await runSpaceCommand("new Bad", f.deps);
	assert.deepEqual(f.notes, [
		["error", 'Space "work" already exists.'],
		["error", 'Invalid space name "Bad": use lowercase letters, digits, "-" and "_", starting with a letter or digit (at most 64 characters).'],
	]);
	assert.equal(existsSync(join(f.dir, "Bad")), false);
});

test("remove asks first, and keeps the space when declined", async () => {
	const f = fake({ confirm: false });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work", f.deps);
	assert.deepEqual(f.confirms, [
		`Remove space "work"? | This deletes ${join(f.dir, "work")} and everything in it: sign-ins, packages, settings and sessions.`,
	]);
	assert.deepEqual(f.notes, [["info", 'Kept space "work".']]);
	assert.equal(existsSync(join(f.dir, "work")), true);

	const g = fake({ confirm: true });
	createSpace(g.dir, "work", "x");
	await runSpaceCommand("remove work", g.deps);
	assert.deepEqual(g.notes, [["info", 'Removed space "work".']]);
	assert.equal(existsSync(join(g.dir, "work")), false);
});

test("remove without a dialog needs --yes", async () => {
	const f = fake({ mode: "print", hasUI: false });
	createSpace(f.dir, "work", "x");
	await runSpaceCommand("remove work", f.deps);
	assert.deepEqual(f.notes, [["error", 'Removing a space needs confirmation; run /space remove work --yes.']]);
	assert.equal(existsSync(join(f.dir, "work")), true);
	f.notes.length = 0;
	await runSpaceCommand("remove work --yes", f.deps);
	assert.deepEqual(f.notes, [["info", 'Removed space "work".']]);
	assert.deepEqual(f.confirms, []);
});

test("remove refuses the active space and missing names before asking", async () => {
	const f = fake({ home: (dir) => join(dir, "work") });
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
			env: { PI_CODING_AGENT_DIR: join(f.dir, "work"), PI_SPACES_BASE_HOME: f.base, PI_SPACE: "work" },
		},
	]);
});

test("switch base goes back to the home Pi started with", async () => {
	const f = fake({ home: (dir) => join(dir, "work") });
	createSpace(f.dir, "work", "x");
	f.deps.env = { PI_CODING_AGENT_DIR: join(f.dir, "work"), PI_SPACES_BASE_HOME: f.base, PI_SPACE: "work" };
	await runSpaceCommand("switch base", f.deps);
	assert.deepEqual(f.notes, [["info", "Switching to the base home; Pi restarts in it."]]);
	assert.deepEqual(f.relaunches[0].env, { PI_CODING_AGENT_DIR: f.base, PI_SPACES_BASE_HOME: f.base });
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
	assert.equal(existsSync(join(f.dir, "b", "settings.json")), true);
});

test("rename refuses base, the active space, a taken name and a space holding the base home", async () => {
	const f = fake({ home: (dir) => join(dir, "work") });
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
	assert.equal(f.relaunches[0].env.PI_CODING_AGENT_DIR, join(f.dir, "work"));
	assert.equal(f.relaunches[0].env.PI_SPACE, "work");

	const g = fake({ home: (dir) => join(dir, "work"), select: (choices) => choices[0] });
	createSpace(g.dir, "work", "x");
	createSpace(g.dir, "alpha", "x");
	g.deps.env = { PI_CODING_AGENT_DIR: join(g.dir, "work"), PI_SPACES_BASE_HOME: g.base, PI_SPACE: "work" };
	await runSpaceCommand("switch", g.deps);
	assert.deepEqual(g.selects, [["Switch to space", ["base", "alpha"]]]);
	assert.deepEqual(g.notes, [["info", "Switching to the base home; Pi restarts in it."]]);
	assert.deepEqual(g.relaunches[0].env, { PI_CODING_AGENT_DIR: g.base, PI_SPACES_BASE_HOME: g.base });
});

test("switch without a name offers only base when the current space is the only one", async () => {
	const f = fake({ home: (dir) => join(dir, "work"), select: () => undefined });
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
	assert.equal(USAGE, "Usage: /space [list | new <name> | remove <name> | rename <old> <new> | switch [<name>]]");
});

test("statusText names the active space only", () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	assert.equal(statusText(f.dir, f.base), undefined);
	assert.equal(statusText(f.dir, join(f.dir, "work")), "space: work");
});

test("completeSpaceArgs completes subcommands, then space names", () => {
	const f = fake();
	createSpace(f.dir, "work", "x");
	createSpace(f.dir, "web", "x");
	const values = (prefix: string) => completeSpaceArgs(prefix, f.dir)?.map((item) => item.value) ?? null;
	assert.deepEqual(values(""), ["list", "new", "remove", "rename", "switch"]);
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
