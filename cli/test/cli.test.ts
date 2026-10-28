import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { launchCommand, main, parseCli, type CliIo } from "../src/cli.ts";

const USAGE = `Usage: pi-space [<name> [pi args...] | list | --help | --version]
  pi-space              pick a space and start Pi in it
  pi-space <name> ...   start Pi in a space ("base" for the home Pi starts with)
  pi-space list         list the spaces
  pi-space --version    print the version
PI_SPACES_COMMAND sets the program to run (default: pi), e.g. "my-launcher --".
`;

interface Run {
	code: number | undefined;
	out: string;
	err: string;
	spawned: { program: string; args: string[]; options: Record<string, unknown> }[];
	dir: string;
}

async function run(
	argv: string[],
	options: { spaces?: string[]; env?: Record<string, string>; tty?: boolean; input?: string; status?: number; spawnError?: string } = {},
): Promise<Run> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-cli-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(dir);
		for (const name of options.spaces ?? []) mkdirSync(join(dir, name));
		const stdin = Object.assign(new PassThrough(), { isTTY: options.tty ?? false });
		if (options.input !== undefined) stdin.end(options.input);
		const result: Run = { code: undefined, out: "", err: "", spawned: [], dir };
		const io: CliIo = {
			stdin,
			stdout: { write: (text: string) => void (result.out += text) },
			stderr: { write: (text: string) => void (result.err += text) },
			env: { PI_SPACES_DIR: dir, ...options.env },
			home: root,
			spawn: async (program, args, spawnOptions) => {
				result.spawned.push({ program, args, options: spawnOptions });
				return options.spawnError ? { status: null, error: new Error(options.spawnError) } : { status: options.status ?? 0 };
			},
			exit: (code) => void (result.code = code),
		};
		await main(argv, io);
		return result;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("parseCli: no arguments opens the picker", () => {
	assert.deepEqual(parseCli([]), { kind: "picker" });
});

test("parseCli: --help and -h", () => {
	assert.deepEqual(parseCli(["--help"]), { kind: "help" });
	assert.deepEqual(parseCli(["-h"]), { kind: "help" });
});

test("parseCli: --version and -v", () => {
	assert.deepEqual(parseCli(["--version"]), { kind: "version" });
	assert.deepEqual(parseCli(["-v"]), { kind: "version" });
});

test("parseCli: any other option in first place is an unknown option, never a space name", () => {
	assert.deepEqual(parseCli(["--bogus"]), { kind: "unknown-option", option: "--bogus" });
	assert.deepEqual(parseCli(["-x", "work"]), { kind: "unknown-option", option: "-x" });
});

test("parseCli: list is the subcommand, a name launches with the rest of the arguments", () => {
	assert.deepEqual(parseCli(["list"]), { kind: "list" });
	assert.deepEqual(parseCli(["work", "-c", "hello"]), { kind: "launch", name: "work", args: ["-c", "hello"] });
	assert.deepEqual(parseCli(["base"]), { kind: "launch", name: "base", args: [] });
});

test("parseCli: --help after a name belongs to Pi; list with extra words is a usage error", () => {
	assert.deepEqual(parseCli(["work", "--help"]), { kind: "launch", name: "work", args: ["--help"] });
	assert.deepEqual(parseCli(["list", "extra"]), { kind: "usage" });
});

test("launchCommand: default program is pi", () => {
	assert.deepEqual(launchCommand({}, "work", ["-c"]), { program: "pi", args: ["--space", "work", "-c"] });
});

test("launchCommand: a multi-word PI_SPACES_COMMAND is split on whitespace", () => {
	assert.deepEqual(launchCommand({ PI_SPACES_COMMAND: "my-launcher --" }, "work", ["-p", "hi"]), {
		program: "my-launcher",
		args: ["--", "--space", "work", "-p", "hi"],
	});
});

test("launchCommand: extra whitespace is ignored; a blank value falls back to pi", () => {
	assert.deepEqual(launchCommand({ PI_SPACES_COMMAND: "  my-launcher   --  " }, "base", []), {
		program: "my-launcher",
		args: ["--", "--space", "base"],
	});
	assert.deepEqual(launchCommand({ PI_SPACES_COMMAND: "   " }, "work", []), { program: "pi", args: ["--space", "work"] });
});

test("--help prints the usage and exits 0", async () => {
	for (const flag of ["--help", "-h"]) {
		const r = await run([flag]);
		assert.equal(r.code, 0);
		assert.equal(r.out, USAGE);
		assert.equal(r.err, "");
		assert.equal(r.spawned.length, 0);
	}
});

test("list prints base and every space, with a hint when there are none", async () => {
	const some = await run(["list"], { spaces: ["work", "alpha"] });
	assert.equal(some.code, 0);
	assert.equal(some.out, `Spaces in ${some.dir}:\n  base\n  alpha\n  work\n`);
	assert.equal(some.err, "");
	const none = await run(["list"]);
	assert.equal(none.code, 0);
	assert.equal(none.out, `Spaces in ${none.dir}:\n  base\nNo spaces yet. Create one with /space new <name> inside Pi.\n`);
});

test("list with extra words prints the usage to stderr and exits 2", async () => {
	const r = await run(["list", "extra"]);
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, USAGE);
});

test("an unknown space exits 1 and spawns nothing", async () => {
	const r = await run(["ghost", "-c"], { spaces: ["work"] });
	assert.equal(r.code, 1);
	assert.equal(r.out, "");
	assert.equal(r.err, 'pi-space: Space "ghost" does not exist.\n');
	assert.equal(r.spawned.length, 0);
});

test("an invalid name exits 1 with the validation message and spawns nothing", async () => {
	const r = await run(["Bad Name"]);
	assert.equal(r.code, 1);
	assert.match(r.err, /^pi-space: Invalid space name "Bad Name"/);
	assert.equal(r.spawned.length, 0);
});

test("--version prints the package version and exits 0", async () => {
	const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
	for (const flag of ["--version", "-v"]) {
		const r = await run([flag]);
		assert.equal(r.code, 0);
		assert.equal(r.out, `${version}\n`);
		assert.equal(r.err, "");
		assert.equal(r.spawned.length, 0);
	}
});

test("an unknown option prints it with the usage to stderr, exits 2 and spawns nothing", async () => {
	const r = await run(["--bogus"]);
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, `pi-space: Unknown option "--bogus".\n${USAGE}`);
	assert.equal(r.spawned.length, 0);
});

test("base passes through without needing a folder", async () => {
	const r = await run(["base", "-p", "hi"], { status: 0 });
	assert.equal(r.code, 0);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "pi", args: ["--space", "base", "-p", "hi"] }]);
});

test("an existing space launches the command with inherited stdio and the untouched env", async () => {
	const r = await run(["work", "-c"], { spaces: ["work"], status: 7, env: { PI_SPACES_COMMAND: "my-launcher --", PI_CODING_AGENT_DIR: "/some/home" } });
	assert.equal(r.code, 7);
	assert.equal(r.spawned.length, 1);
	assert.equal(r.spawned[0].program, "my-launcher");
	assert.deepEqual(r.spawned[0].args, ["--", "--space", "work", "-c"]);
	assert.equal(r.spawned[0].options.stdio, "inherit");
	assert.equal(r.spawned[0].options.env, undefined);
});

test("a command that cannot start prints the reason and exits 1", async () => {
	const r = await run(["work"], { spaces: ["work"], spawnError: "spawn pi ENOENT" });
	assert.equal(r.code, 1);
	assert.equal(r.err, "pi-space: could not start pi: spawn pi ENOENT\n");
});

test("picker: a valid number launches that space", async () => {
	const r = await run([], { spaces: ["alpha", "work"], tty: true, input: "3\n", status: 0 });
	assert.equal(r.code, 0);
	assert.equal(r.out, `Spaces in ${r.dir}:\n1) base\n2) alpha\n3) work\nSpace number: `);
	assert.deepEqual(r.spawned.map(({ args }) => args), [["--space", "work"]]);
});

test("picker: 1 launches base", async () => {
	const r = await run([], { spaces: ["work"], tty: true, input: " 1 \n" });
	assert.deepEqual(r.spawned.map(({ args }) => args), [["--space", "base"]]);
});

test("picker: an empty line or EOF exits 0 without launching", async () => {
	for (const input of ["\n", ""]) {
		const r = await run([], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.spawned.length, 0);
		assert.equal(r.err, "");
	}
});

test("picker: an out-of-range or non-numeric answer exits 1 without launching", async () => {
	for (const input of ["3\n", "0\n", "abc\n", "-1\n"]) {
		const r = await run([], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 1, input);
		assert.equal(r.err, "pi-space: Choose a number from 1 to 2.\n");
		assert.equal(r.spawned.length, 0);
	}
});

test("picker: without a terminal the usage goes to stderr and the exit code is 2", async () => {
	const r = await run([], { spaces: ["work"], tty: false, input: "2\n" });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, USAGE);
	assert.equal(r.spawned.length, 0);
});

test("bin/pi-space.mjs --version prints the package version", () => {
	const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
	const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
	const result = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `${version}\n`);
});

test("bin/pi-space.mjs runs PI_SPACES_COMMAND with --space and exits with its code", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(join(dir, "work"), { recursive: true });
		const script = join(root, "fake.mjs");
		writeFileSync(
			script,
			'console.log(JSON.stringify({ argv: process.argv.slice(2), dir: process.env.PI_SPACES_DIR, home: process.env.PI_CODING_AGENT_DIR })); process.exit(7);\n',
		);
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const result = spawnSync(process.execPath, [bin, "work", "-c"], {
			encoding: "utf8",
			env: { ...process.env, PI_SPACES_DIR: dir, PI_SPACES_COMMAND: `${process.execPath} ${script}`, PI_CODING_AGENT_DIR: "/some/home" },
		});
		assert.equal(result.status, 7, result.stderr);
		const seen = JSON.parse(result.stdout);
		assert.deepEqual(seen.argv, ["--space", "work", "-c"]);
		assert.equal(seen.dir, dir);
		assert.ok(existsSync(join(seen.dir, "work")));
		assert.equal(seen.home, "/some/home");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
