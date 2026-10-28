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
	assert.deepEqual(parseSpaceFlag(["--model", "m", "hi"]), { name: undefined, rest: ["--model", "m", "hi"] });
	assert.deepEqual(parseSpaceFlag(["--space", "work", "-c", "hi"]), { name: "work", rest: ["-c", "hi"] });
	assert.deepEqual(parseSpaceFlag(["-c", "--space=work"]), { name: "work", rest: ["-c"] });
	assert.deepEqual(parseSpaceFlag(["--", "--space", "work"]), { name: undefined, rest: ["--", "--space", "work"] });
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
