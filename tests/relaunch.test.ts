import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SpaceError } from "../src/spaces.ts";
import { filterArgs, relaunchCommand, relaunchEnv, resolveSwitch } from "../src/relaunch.ts";

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
	const env = relaunchEnv(
		{
			PI_CODING_AGENT_DIR: "/h/agent",
			HOST_AGENT_HOME: "/h/agent",
			HOST_CONFIG: "/h/agent/config",
			SIMILAR: "/h/agent-other",
			UNRELATED: "/elsewhere",
			PI_SPACE: "old",
		},
		{ currentHome: "/h/agent", targetHome: "/s/work", baseHome: "/h/agent", space: "work" },
	);
	assert.deepEqual(env, {
		PI_CODING_AGENT_DIR: "/s/work",
		HOST_AGENT_HOME: "/s/work",
		HOST_CONFIG: "/s/work/config",
		SIMILAR: "/h/agent-other",
		UNRELATED: "/elsewhere",
		PI_SPACE: "work",
		PI_SPACES_BASE_HOME: "/h/agent",
	});

	const back = relaunchEnv(
		{ PI_CODING_AGENT_DIR: "/s/work", PI_SPACE: "work", PI_SPACES_BASE_HOME: "/h/agent", PI_SPACES_DIR: "/s/work/x" },
		{ currentHome: "/s/work", targetHome: "/h/agent", baseHome: "/h/agent", space: undefined },
	);
	assert.deepEqual(back, { PI_CODING_AGENT_DIR: "/h/agent", PI_SPACES_BASE_HOME: "/h/agent", PI_SPACES_DIR: "/s/work/x" });
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
	const module = fileURLToPath(new URL("../src/relaunch.ts", import.meta.url));
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
