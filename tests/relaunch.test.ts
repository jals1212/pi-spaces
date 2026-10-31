import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { SpaceError } from "../src/spaces.ts";
import { filterArgs, parseSpaceFlag, planStartup, relaunchCommand, relaunchEnv, resolveSwitch, runNow } from "../src/relaunch.ts";

test("filterArgs keeps options and drops the prompt, @files, session options and everything after --", () => {
	assert.deepEqual(filterArgs([]), []);
	assert.deepEqual(
		filterArgs(["--model", "sonnet:high", "-e", "./ext.ts", "--tools=read,bash", "--verbose", "fix the bug", "@notes.md"]),
		["--model", "sonnet:high", "-e", "./ext.ts", "--tools=read,bash", "--verbose"],
	);
	assert.deepEqual(
		filterArgs(["-c", "--continue", "-r", "--resume", "--no-session", "--session", "abc", "--session-id", "id1", "--fork", "f", "--session-dir", "/d", "-n", "nm", "--name", "nm2", "--session=x", "--verbose"]),
		["--verbose"],
	);
	assert.deepEqual(filterArgs(["--thinking", "high", "--", "-starts with dash"]), ["--thinking", "high"]);
	assert.deepEqual(filterArgs(["--my-ext-flag", "-a"]), ["--my-ext-flag", "-a"]);
});

test("filterArgs keeps the value of an unknown extension flag, as Pi parses it", () => {
	assert.deepEqual(filterArgs(["--my-flag", "v", "--model", "m", "prompt"]), ["--my-flag", "v", "--model", "m"]);
	assert.deepEqual(filterArgs(["--my-flag", "--other", "@f.md"]), ["--my-flag", "--other"]);
	assert.deepEqual(filterArgs(["--my-flag=v", "prompt"]), ["--my-flag=v"]);
	assert.deepEqual(filterArgs(["--tui-mode", "--verbose"]), ["--tui-mode", "--verbose"]);
});

test("resolveSwitch targets a space folder or the base home, and refuses the rest", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const dir = join(root, "spaces");
	mkdirSync(join(dir, "work"), { recursive: true });
	const base = join(root, "agent");

	assert.deepEqual(resolveSwitch({ dir, name: "work", currentHome: base, env: {} }), { space: "work", targetHome: join(dir, "work"), baseHome: base });
	assert.deepEqual(resolveSwitch({ dir, name: "base", currentHome: join(dir, "work"), env: { PI_SPACES_BASE_HOME: base } }), {
		space: undefined,
		targetHome: base,
		baseHome: base,
	});
	assert.throws(() => resolveSwitch({ dir, name: "ghost", currentHome: base, env: {} }), new SpaceError('Space "ghost" does not exist.'));
	assert.throws(() => resolveSwitch({ dir, name: "work", currentHome: join(dir, "work"), env: { PI_SPACES_BASE_HOME: base } }), new SpaceError('Already in space "work".'));
	assert.throws(() => resolveSwitch({ dir, name: "base", currentHome: base, env: {} }), new SpaceError("Already in the base home."));
	assert.throws(() => resolveSwitch({ dir, name: "Bad", currentHome: base, env: {} }), SpaceError);
});

test("relaunchEnv points Pi at the target and rewrites every variable inside the current home", () => {
	// Absolute on every system: on Windows a path written with "/" and no drive gets the current drive.
	const path = (...parts: string[]) => resolve(join(...parts));
	const home = path("/h/agent");
	const target = path("/s/work");
	const env = relaunchEnv(
		{
			PI_CODING_AGENT_DIR: home,
			HOST_AGENT_HOME: home,
			HOST_CONFIG: join(home, "config"),
			SIMILAR: path("/h/agent-other"),
			PWD: join(home, "proj"),
			OLDPWD: home,
			UNRELATED: path("/elsewhere"),
			LIST: [path("/usr/bin"), join(home, "bin"), join(path("/h/agent-other"), "bin")].join(delimiter),
			PI_SPACE: "old",
		},
		{ currentHome: home, targetHome: target, baseHome: home, space: "work" },
	);
	assert.deepEqual(env, {
		PI_CODING_AGENT_DIR: target,
		HOST_AGENT_HOME: target,
		HOST_CONFIG: join(target, "config"),
		SIMILAR: path("/h/agent-other"),
		PWD: join(home, "proj"),
		OLDPWD: home,
		UNRELATED: path("/elsewhere"),
		LIST: [path("/usr/bin"), join(target, "bin"), join(path("/h/agent-other"), "bin")].join(delimiter),
		PI_SPACE: "work",
		PI_SPACES_BASE_HOME: home,
	});

	const back = relaunchEnv(
		{ PI_CODING_AGENT_DIR: target, PI_SPACE: "work", PI_SPACES_BASE_HOME: home, PI_SPACES_DIR: join(target, "x") },
		{ currentHome: target, targetHome: home, baseHome: home, space: undefined },
	);
	assert.deepEqual(back, { PI_CODING_AGENT_DIR: home, PI_SPACES_BASE_HOME: home, PI_SPACES_DIR: join(target, "x") });
});

test("relaunchEnv with spaceEnv sets it for a space, removes it for base, and recomputes it between spaces", () => {
	const path = (...parts: string[]) => resolve(join(...parts));
	const base = path("/h/agent");
	const dir = path("/h/spaces");
	const spaceEnv = { HOST_CFG: "{home}/cfg", HOST_LABEL: "label-{name}" };
	const plain = { PI_CODING_AGENT_DIR: base, UNRELATED: path("/elsewhere") };

	// Entering a space: set from the templates, even when the base already had the variable.
	const entered = relaunchEnv({ ...plain, HOST_CFG: path("/shared/cfg") }, { currentHome: base, targetHome: join(dir, "work"), baseHome: base, space: "work", spaceEnv });
	assert.deepEqual(entered, {
		PI_CODING_AGENT_DIR: join(dir, "work"),
		UNRELATED: path("/elsewhere"),
		HOST_CFG: join(dir, "work", "cfg"),
		HOST_LABEL: "label-work",
		PI_SPACES_BASE_HOME: base,
		PI_SPACE: "work",
		// The base's own values of those variables, kept to be put back on the way back to base.
		PI_SPACES_BASE_ENV: JSON.stringify({ HOST_CFG: path("/shared/cfg") }),
	});

	// Between spaces: recomputed for the target, not moved from the old space.
	const between = relaunchEnv(
		{ ...entered, PI_CODING_AGENT_DIR: join(dir, "work"), HOST_CFG: join(dir, "work", "cfg"), HOST_LABEL: "label-work", HOST_OTHER: join(dir, "work", "x") },
		{ currentHome: join(dir, "work"), targetHome: join(dir, "play"), baseHome: base, space: "play", spaceEnv },
	);
	assert.equal(between.HOST_CFG, join(dir, "play", "cfg"));
	assert.equal(between.HOST_LABEL, "label-play");
	// A variable that is not in spaceEnv still moves with the home.
	assert.equal(between.HOST_OTHER, join(dir, "play", "x"));
	// The base's values travel unchanged from space to space.
	assert.equal(between.PI_SPACES_BASE_ENV, entered.PI_SPACES_BASE_ENV);

	// A value that pointed into the old space but whose template does not use {home} is replaced, not moved.
	const replaced = relaunchEnv(
		{ PI_CODING_AGENT_DIR: join(dir, "work"), PI_SPACES_BASE_HOME: base, PI_SPACE: "work", FIXED: join(dir, "work", "f") },
		{ currentHome: join(dir, "work"), targetHome: join(dir, "play"), baseHome: base, space: "play", spaceEnv: { FIXED: "/fixed/{name}" } },
	);
	assert.equal(replaced.FIXED, "/fixed/play");

	// Back to base: the variables are removed and the rest is as without spaceEnv.
	const back = relaunchEnv(
		{ PI_CODING_AGENT_DIR: join(dir, "work"), PI_SPACES_BASE_HOME: base, PI_SPACE: "work", HOST_CFG: join(dir, "work", "cfg"), HOST_LABEL: "label-work", UNRELATED: "u" },
		{ currentHome: join(dir, "work"), targetHome: base, baseHome: base, space: undefined, spaceEnv },
	);
	assert.deepEqual(back, { PI_CODING_AGENT_DIR: base, PI_SPACES_BASE_HOME: base, UNRELATED: "u" });

	// Back to base after a trip through two spaces: the base gets its own values again, untouched.
	const restored = relaunchEnv({ ...between, PI_CODING_AGENT_DIR: join(dir, "play") }, { currentHome: join(dir, "play"), targetHome: base, baseHome: base, space: undefined, spaceEnv });
	assert.equal(restored.HOST_CFG, path("/shared/cfg"));
	assert.equal("HOST_LABEL" in restored, false);
	assert.equal("PI_SPACES_BASE_ENV" in restored, false);

	// A value with $ stays literal.
	const dollar = relaunchEnv(plain, { currentHome: base, targetHome: join(dir, "work"), baseHome: base, space: "work", spaceEnv: { COST: "$&{name}$1" } });
	assert.equal(dollar.COST, "$&work$1");
});

test("relaunchEnv without spaceEnv, or with an empty one, is the same as before", () => {
	const path = (...parts: string[]) => resolve(join(...parts));
	const base = path("/h/agent");
	const input = { PI_CODING_AGENT_DIR: base, HOST_CFG: join(base, "cfg"), KEEP: "k" };
	const target = { currentHome: base, targetHome: path("/s/work"), baseHome: base, space: "work" };
	const without = relaunchEnv(input, target);
	assert.deepEqual(without, { PI_CODING_AGENT_DIR: path("/s/work"), HOST_CFG: join(path("/s/work"), "cfg"), KEEP: "k", PI_SPACES_BASE_HOME: base, PI_SPACE: "work" });
	assert.deepEqual(relaunchEnv(input, { ...target, spaceEnv: {} }), without);
});

test("planStartup passes the profile's spaceEnv to the environment of the relaunch", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const dir = join(root, "spaces");
	mkdirSync(join(dir, "work"), { recursive: true });
	const base = join(root, "agent");
	const proc = (args: string[]) => ({ execPath: "/n/node", execArgv: [], argv: ["/n/node", "/p/cli.js", ...args] });
	const spaceEnv = { HOST_CFG: "{home}/cfg" };

	assert.deepEqual(planStartup({ proc: proc(["--space", "work"]), dir, currentHome: base, env: { PI_CODING_AGENT_DIR: base }, spaceEnv }), {
		kind: "relaunch",
		command: { command: "/n/node", args: ["/p/cli.js"] },
		env: { PI_CODING_AGENT_DIR: join(dir, "work"), PI_SPACE: "work", PI_SPACES_BASE_HOME: base, HOST_CFG: join(dir, "work", "cfg"), PI_SPACES_BASE_ENV: "{}" },
	});
	// Base again: removed.
	assert.deepEqual(
		planStartup({
			proc: proc(["--space", "base", "update"]),
			dir,
			currentHome: join(dir, "work"),
			env: { PI_SPACES_BASE_HOME: base, PI_CODING_AGENT_DIR: join(dir, "work"), PI_SPACE: "work", HOST_CFG: join(dir, "work", "cfg") },
			spaceEnv,
		}),
		{
			kind: "relaunch",
			command: { command: "/n/node", args: ["/p/cli.js", "update"] },
			env: { PI_SPACES_BASE_HOME: base, PI_CODING_AGENT_DIR: base },
		},
	);
});

test("relaunchCommand reruns the same runtime and entry script with the filtered arguments", () => {
	assert.deepEqual(relaunchCommand({ execPath: "/n/node", execArgv: ["--no-warnings"], argv: ["/n/node", "/p/cli.js", "-c", "--model", "m", "hi"] }), {
		command: "/n/node",
		args: ["--no-warnings", "/p/cli.js", "--model", "m"],
	});
	assert.deepEqual(relaunchCommand({ execPath: "/b/pi", execArgv: [], argv: ["/b/pi", "/$bunfs/root/pi", "-r"] }), { command: "/b/pi", args: [] });
});

test("scheduleRelaunch runs the command with inherited stdio when the process exits, and exits with its code", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const child = join(root, "child.mjs");
	writeFileSync(child, 'console.log("relaunched", process.env.PI_SPACE, process.argv.slice(2).join(" ")); process.exit(7);\n');
	const parent = join(root, "parent.ts");
	// A file URL, since a Windows path is not a valid import specifier.
	const module = new URL("../src/relaunch.ts", import.meta.url).href;
	writeFileSync(
		parent,
		`import { scheduleRelaunch } from ${JSON.stringify(module)};\n` +
			`scheduleRelaunch({ command: process.execPath, args: [${JSON.stringify(child)}, "a", "b"] }, { ...process.env, PI_SPACE: "work" });\n` +
			`console.log("parent exiting");\nprocess.exit(0);\n`,
	);
	const result = spawnSync(process.execPath, [parent], { encoding: "utf8" });
	assert.equal(result.stdout, "parent exiting\nrelaunched work a b\n");
	assert.equal(result.status, 7);
});

test("parseSpaceFlag takes --space <name> or --space=<name> and leaves everything else", () => {
	assert.deepEqual(parseSpaceFlag(["--model", "m", "hi"]), { name: undefined, rest: ["--model", "m", "hi"], afterName: [] });
	assert.deepEqual(parseSpaceFlag(["--space", "work", "-c", "hi"]), { name: "work", rest: ["-c", "hi"], afterName: ["-c", "hi"] });
	assert.deepEqual(parseSpaceFlag(["-c", "--space=work"]), { name: "work", rest: ["-c"], afterName: [] });
	assert.deepEqual(parseSpaceFlag(["-e", "x", "--space", "work", "list"]), { name: "work", rest: ["-e", "x", "list"], afterName: ["list"] });
	assert.deepEqual(parseSpaceFlag(["--", "--space", "work"]), { name: undefined, rest: ["--", "--space", "work"], afterName: [] });
	for (const args of [["--space"], ["--space", "-c"], ["--space="]]) {
		assert.deepEqual(parseSpaceFlag(args), { error: "--space needs a space name: pi --space <name>." }, args.join(" "));
	}
});

test("planStartup relaunches in the space with every other argument, prompt and session options included", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const dir = join(root, "spaces");
	mkdirSync(join(dir, "work"), { recursive: true });
	const base = join(root, "agent");
	const proc = (args: string[]) => ({ execPath: "/n/node", execArgv: [], argv: ["/n/node", "/p/cli.js", ...args] });

	assert.deepEqual(planStartup({ proc: proc(["hi"]), dir, currentHome: base, env: {} }), { kind: "none" });
	assert.deepEqual(planStartup({ proc: proc(["--space", "work", "-c", "fix it"]), dir, currentHome: base, env: { PI_CODING_AGENT_DIR: base } }), {
		kind: "relaunch",
		command: { command: "/n/node", args: ["/p/cli.js", "-c", "fix it"] },
		env: { PI_CODING_AGENT_DIR: join(dir, "work"), PI_SPACE: "work", PI_SPACES_BASE_HOME: base },
	});
	assert.deepEqual(planStartup({ proc: proc(["--space", "work"]), dir, currentHome: join(dir, "work"), env: { PI_SPACES_BASE_HOME: base } }), { kind: "none" });
	assert.deepEqual(planStartup({ proc: proc(["--space", "base"]), dir, currentHome: base, env: {} }), { kind: "none" });
	assert.deepEqual(planStartup({ proc: proc(["--space", "ghost"]), dir, currentHome: base, env: {} }), { kind: "error", message: 'Space "ghost" does not exist.' });
	assert.deepEqual(planStartup({ proc: proc(["--space"]), dir, currentHome: base, env: {} }), { kind: "error", message: "--space needs a space name: pi --space <name>." });
});

test("planStartup runs a Pi package command in the target home, the current one included", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const dir = join(root, "spaces");
	mkdirSync(join(dir, "work"), { recursive: true });
	const base = join(root, "agent");
	const proc = (args: string[]) => ({ execPath: "/n/node", execArgv: [], argv: ["/n/node", "/p/cli.js", ...args] });

	// Another home: the space's environment, and the command with its arguments as written.
	assert.deepEqual(planStartup({ proc: proc(["--space", "work", "update", "--extensions"]), dir, currentHome: base, env: {} }), {
		kind: "relaunch",
		command: { command: "/n/node", args: ["/p/cli.js", "update", "--extensions"] },
		env: { PI_CODING_AGENT_DIR: join(dir, "work"), PI_SPACE: "work", PI_SPACES_BASE_HOME: base },
	});
	// The current home: Pi started with --space first, so it runs again with the command first, environment unchanged.
	for (const command of ["install", "remove", "uninstall", "update", "list"]) {
		assert.deepEqual(planStartup({ proc: proc(["--space", "base", command, "npm:x"]), dir, currentHome: base, env: { A: "1" } }), {
			kind: "relaunch",
			command: { command: "/n/node", args: ["/p/cli.js", command, "npm:x"] },
			env: { A: "1" },
		}, command);
	}
	const inWork = { PI_SPACES_BASE_HOME: base, PI_SPACE: "work" };
	assert.deepEqual(planStartup({ proc: proc(["--space", "work", "list"]), dir, currentHome: join(dir, "work"), env: inWork }), {
		kind: "relaunch",
		command: { command: "/n/node", args: ["/p/cli.js", "list"] },
		env: inWork,
	});
	// Options before --space (a launcher may add its own, such as -e) do not belong to the package command.
	assert.deepEqual(planStartup({ proc: proc(["-e", "/pkg", "--space", "work", "list"]), dir, currentHome: base, env: {} }), {
		kind: "relaunch",
		command: { command: "/n/node", args: ["/p/cli.js", "list"] },
		env: { PI_CODING_AGENT_DIR: join(dir, "work"), PI_SPACE: "work", PI_SPACES_BASE_HOME: base },
	});
	assert.deepEqual(planStartup({ proc: proc(["-e", "/pkg", "--space=base", "update"]), dir, currentHome: base, env: {} }), {
		kind: "relaunch",
		command: { command: "/n/node", args: ["/p/cli.js", "update"] },
		env: {},
	});
	// Only right after the name: a later word is still a prompt.
	assert.deepEqual(planStartup({ proc: proc(["--space", "base", "-p", "update"]), dir, currentHome: base, env: {} }), { kind: "none" });
	assert.deepEqual(planStartup({ proc: proc(["--space", "ghost", "update"]), dir, currentHome: base, env: {} }), { kind: "error", message: 'Space "ghost" does not exist.' });
});

test("runNow runs the command with inherited stdio and returns its exit code", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const child = join(root, "child.mjs");
	writeFileSync(child, 'console.log("child", process.env.PI_SPACE); process.exit(3);\n');
	const parent = join(root, "parent.ts");
	// A file URL, since a Windows path is not a valid import specifier.
	const module = new URL("../src/relaunch.ts", import.meta.url).href;
	writeFileSync(
		parent,
		`import { runNow } from ${JSON.stringify(module)};\n` +
			`const code = runNow({ command: process.execPath, args: [${JSON.stringify(child)}] }, { ...process.env, PI_SPACE: "work" });\n` +
			`console.log("code", code);\n` +
			`console.log("missing", runNow({ command: "/nonexistent/pi", args: [] }, process.env));\n`,
	);
	const result = spawnSync(process.execPath, [parent], { encoding: "utf8" });
	assert.equal(result.stdout, "child work\ncode 3\nmissing 1\n");
	assert.match(result.stderr, /pi-spaces: could not start Pi again: .*ENOENT/);
});
