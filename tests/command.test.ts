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
	relaunches: { command: unknown; env: Record<string, string | undefined> }[];
	shutdowns: number;
	dir: string;
	base: string;
}

function fake(options: { mode?: "tui" | "print"; hasUI?: boolean; confirm?: boolean; home?: (dir: string, base: string) => string } = {}): Fake {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const dir = join(root, "spaces");
	const base = join(root, "agent");
	mkdirSync(base);
	const f: Fake = { notes: [], confirms: [], relaunches: [], shutdowns: 0, dir, base, deps: undefined as never };
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
	await runSpaceCommand("", f.deps);
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

test("unknown subcommands and missing names show the usage", async () => {
	const f = fake();
	for (const args of ["nope", "new", "remove", "switch", "new a b"]) await runSpaceCommand(args, f.deps);
	assert.deepEqual(f.notes, Array(5).fill(["error", USAGE]));
	assert.equal(USAGE, "Usage: /space [list | new <name> | remove <name> | switch <name>]");
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
	assert.deepEqual(values(""), ["list", "new", "remove", "switch"]);
	assert.deepEqual(values("s"), ["switch"]);
	assert.deepEqual(values("switch "), ["switch base", "switch web", "switch work"]);
	assert.deepEqual(values("remove w"), ["remove web", "remove work"]);
	assert.deepEqual(values("new "), null);
});
