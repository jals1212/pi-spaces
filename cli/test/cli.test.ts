import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchCommand, main, parseCli, type CliIo } from "../src/cli.ts";

const USAGE = `Usage: pi-space [--command <cmd>] [--dir <path>] [<name> [pi args...] | list | --new <name> | --remove <name> [--yes] [--no-backup]]
       pi-space --help | --version
  pi-space                   pick a space and start Pi in it
  pi-space <name> ...        start Pi in a space ("base" for the home Pi starts with)
  pi-space list              list the spaces
  pi-space --new <name>      create a space
  pi-space --remove <name>   delete a space and everything in it, after asking, and keep a backup in .backups unless told not to
                             (--yes skips the questions; --no-backup deletes without a backup)
  pi-space --version         print the version
Options for this call only:
  --command <cmd>            the program to run instead of $PI_SPACES_COMMAND (default: pi), e.g. "my-launcher --"
  --dir <path>               the spaces folder instead of $PI_SPACES_DIR; the Pi it starts gets it too
`;

interface Run {
	code: number | undefined;
	out: string;
	err: string;
	spawned: { program: string; args: string[]; options: Record<string, unknown> }[];
	dir: string;
	/** Each space's settings.json after the run, by name. */
	settings: Record<string, unknown>;
	/** The space folders left after the run. */
	left: string[];
	/** The folders in <spaces>/.backups after the run. */
	backups: string[];
	root: string;
}

async function run(
	argv: string[],
	options: {
		spaces?: string[];
		env?: Record<string, string>;
		tty?: boolean;
		input?: string;
		status?: number;
		spawnError?: string;
		/** packages for <root>/agent/settings.json, the base home when PI_CODING_AGENT_DIR is "<root>/agent". */
		basePackages?: unknown[];
		/** A local copy of the extension at <root>/checkout, known by its package.json name. */
		checkout?: boolean;
		/** Make the spaces folder read-only while the command runs. */
		readOnly?: boolean;
	} = {},
): Promise<Run> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-cli-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(dir);
		for (const name of options.spaces ?? []) mkdirSync(join(dir, name));
		const stdin = Object.assign(new PassThrough(), { isTTY: options.tty ?? false });
		if (options.input !== undefined) stdin.end(options.input);
		if (options.checkout) {
			mkdirSync(join(root, "checkout"));
			writeFileSync(join(root, "checkout", "package.json"), JSON.stringify({ name: "@jals1212/pi-spaces" }));
		}
		if (options.basePackages) {
			mkdirSync(join(root, "agent"));
			writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ packages: options.basePackages }));
		}
		const env = Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, value.replace("<root>", root)]));
		const result: Run = { code: undefined, out: "", err: "", spawned: [], dir, settings: {}, left: [], backups: [], root };
		const io: CliIo = {
			stdin,
			stdout: { write: (text: string) => void (result.out += text) },
			stderr: { write: (text: string) => void (result.err += text) },
			env: { PI_SPACES_DIR: dir, PI_CODING_AGENT_DIR: join(root, "no-agent"), ...env },
			home: root,
			spawn: async (program, args, spawnOptions) => {
				result.spawned.push({ program, args, options: spawnOptions });
				return options.spawnError ? { status: null, error: new Error(options.spawnError) } : { status: options.status ?? 0 };
			},
			exit: (code) => void (result.code = code),
		};
		if (options.readOnly) chmodSync(dir, 0o555);
		try {
			await main(
				argv.map((arg) => arg.replace("<root>", root)),
				io,
			);
		} finally {
			chmodSync(dir, 0o755);
		}
		const backups = join(dir, ".backups");
		if (existsSync(backups)) result.backups = readdirSync(backups).sort();
		for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
			if (name === ".backups") continue;
			result.left.push(name);
			const file = join(dir, name, "settings.json");
			if (existsSync(file)) result.settings[name] = JSON.parse(readFileSync(file, "utf8"));
		}
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

test("parseCli: --new takes exactly one name", () => {
	assert.deepEqual(parseCli(["--new", "work"]), { kind: "new", name: "work" });
	assert.deepEqual(parseCli(["--new"]), { kind: "usage" });
	assert.deepEqual(parseCli(["--new", "a", "b"]), { kind: "usage" });
	assert.deepEqual(parseCli(["new"]), { kind: "launch", name: "new", args: [] });
});

test("parseCli: --remove takes one name, with --yes (-y) and --no-backup on either side; --delete is not an option", () => {
	assert.deepEqual(parseCli(["--remove", "work"]), { kind: "remove", name: "work", yes: false, backup: true });
	assert.deepEqual(parseCli(["--remove", "work", "--yes"]), { kind: "remove", name: "work", yes: true, backup: true });
	assert.deepEqual(parseCli(["--remove", "-y", "work"]), { kind: "remove", name: "work", yes: true, backup: true });
	assert.deepEqual(parseCli(["--remove", "--no-backup", "work", "--yes"]), { kind: "remove", name: "work", yes: true, backup: false });
	assert.deepEqual(parseCli(["--delete", "work"]), { kind: "unknown-option", option: "--delete" });
	for (const argv of [
		["--remove"],
		["--remove", "--yes"],
		["--remove", "a", "b"],
		["--remove", "a", "--yes", "b"],
		["--remove", "a", "--yes", "-y"],
		["--remove", "a", "--no-backup", "--no-backup"],
		["--remove", "a", "--backup"],
	]) {
		assert.deepEqual(parseCli(argv), { kind: "usage" }, argv.join(" "));
	}
});

test("parseCli: --command and --dir come first, in any order, and apply to whatever follows", () => {
	assert.deepEqual(parseCli(["--command", "my-launcher --", "--dir", "/d", "work", "-c"]), {
		kind: "launch",
		name: "work",
		args: ["-c"],
		command: "my-launcher --",
		dir: "/d",
	});
	assert.deepEqual(parseCli(["--dir", "/d", "list"]), { kind: "list", dir: "/d" });
	assert.deepEqual(parseCli(["--dir", "/d", "--new", "x"]), { kind: "new", name: "x", dir: "/d" });
	assert.deepEqual(parseCli(["--command", "my-launcher"]), { kind: "picker", command: "my-launcher" });
});

test("parseCli: --command or --dir without a value, or given twice, is a usage error", () => {
	for (const argv of [["--command"], ["--dir"], ["--command", ""], ["--dir", "", "work"], ["--dir", "/a", "--dir", "/b"], ["--command", "x", "--command", "y"]]) {
		assert.deepEqual(parseCli(argv), { kind: "usage" }, JSON.stringify(argv));
	}
});

test("parseCli: --command, --dir and --yes after a space name belong to Pi", () => {
	assert.deepEqual(parseCli(["work", "--command", "x", "--dir", "/d", "--yes"]), {
		kind: "launch",
		name: "work",
		args: ["--command", "x", "--dir", "/d", "--yes"],
	});
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
	assert.equal(none.out, `Spaces in ${none.dir}:\n  base\nNo spaces yet. Create one with pi-space --new <name>.\n`);
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

test("--new creates the space with npm:@jals1212/pi-spaces when the base home does not declare it, and spawns nothing", async () => {
	const r = await run(["--new", "work"]);
	assert.equal(r.code, 0);
	assert.equal(r.out, `Created space "work" at ${join(r.dir, "work")}.\nStart Pi in it with: pi-space work\n`);
	assert.equal(r.err, "");
	assert.deepEqual(r.settings, { work: { packages: ["npm:@jals1212/pi-spaces"] } });
	assert.equal(r.spawned.length, 0);
});

test("--new copies the base home's declaration of the extension, as /space new does", async () => {
	const declaration = { source: "npm:@jals1212/pi-spaces@0.1.1", extensions: ["extensions/spaces.ts"] };
	const r = await run(["--new", "work"], { basePackages: ["npm:other", declaration], env: { PI_CODING_AGENT_DIR: "<root>/agent" } });
	assert.equal(r.code, 0);
	assert.deepEqual(r.settings.work, { packages: [declaration] });
	const fromSpace = await run(["--new", "work"], {
		basePackages: ["git:github.com/jals1212/pi-spaces"],
		env: { PI_CODING_AGENT_DIR: "<root>/spaces/other", PI_SPACES_BASE_HOME: "<root>/agent" },
	});
	assert.deepEqual(fromSpace.settings.work, { packages: ["git:github.com/jals1212/pi-spaces"] });
});

test("--new copies a local path to another copy of the extension from the base home", async () => {
	const r = await run(["--new", "work"], {
		checkout: true,
		basePackages: [{ source: "../checkout", extensions: ["extensions/spaces.ts"] }],
		env: { PI_CODING_AGENT_DIR: "<root>/agent" },
	});
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.settings.work, { packages: [{ source: join(r.root, "checkout"), extensions: ["extensions/spaces.ts"] }] });
});

test("--new copies the local path the base home loads the extension from, when it is the folder this command resolves", async () => {
	const packageRoot = dirname(fileURLToPath(import.meta.resolve("@jals1212/pi-spaces/package.json")));
	const r = await run(["--new", "work"], { basePackages: [packageRoot], env: { PI_CODING_AGENT_DIR: "<root>/agent" } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.settings.work, { packages: [packageRoot] });
});

test("--new refuses a taken, reserved or invalid name with exit 1", async () => {
	const taken = await run(["--new", "work"], { spaces: ["work"] });
	assert.equal(taken.code, 1);
	assert.equal(taken.err, 'pi-space: Space "work" already exists.\n');
	assert.deepEqual(taken.settings, {});
	const reserved = await run(["--new", "base"]);
	assert.equal(reserved.code, 1);
	assert.match(reserved.err, /^pi-space: "base" is reserved/);
	const invalid = await run(["--new", "Bad Name"]);
	assert.equal(invalid.code, 1);
	assert.match(invalid.err, /^pi-space: Invalid space name "Bad Name"/);
});

test("--new without exactly one name prints the usage to stderr and exits 2", async () => {
	for (const argv of [["--new"], ["--new", "a", "b"]]) {
		const r = await run(argv);
		assert.equal(r.code, 2);
		assert.equal(r.err, USAGE);
		assert.deepEqual(r.settings, {});
	}
});

test("--remove --yes keeps a backup in .backups and leaves the other spaces", async () => {
	const r = await run(["--remove", "work", "--yes"], { spaces: ["work", "other"] });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.backups.length, 1);
	assert.match(r.backups[0], /^work-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
	assert.equal(r.out, `Removed space "work"; its backup is ${join(r.dir, ".backups", r.backups[0])}.\n`);
	assert.equal(r.err, "");
	assert.deepEqual(r.left, ["other"]);
	assert.equal(r.spawned.length, 0);
});

test("--remove --yes reports a backup that cannot be written with exit 1 and keeps the space", { skip: process.getuid?.() === 0 }, async () => {
	const r = await run(["--remove", "work", "--yes"], { spaces: ["work"], readOnly: true });
	assert.equal(r.code, 1);
	assert.match(r.err, /^pi-space: Could not back up space "work": .*EACCES.*\. The space was not removed; fix that, or remove it without a backup with --no-backup\.\n$/);
	assert.equal(r.out, "");
	assert.deepEqual(r.left, ["work"]);
	assert.deepEqual(r.backups, []);
});

test("--remove --yes --no-backup deletes without a backup", async () => {
	const r = await run(["--remove", "work", "--yes", "--no-backup"], { spaces: ["work", "other"] });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, 'Removed space "work".\n');
	assert.deepEqual(r.left, ["other"]);
	assert.deepEqual(r.backups, []);
});

test("--delete is an unknown option: usage to stderr, exit 2, nothing removed", async () => {
	const r = await run(["--delete", "work", "--yes"], { spaces: ["work"] });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, `pi-space: Unknown option "--delete".\n${USAGE}`);
	assert.deepEqual(r.left, ["work"]);
	assert.equal(r.spawned.length, 0);
});

const removeQuestion = (dir: string) =>
	`Remove space "work"? This deletes ${join(dir, "work")} and everything in it: sign-ins, packages, settings and sessions. [y/N] `;
const backupQuestion = (dir: string) => `Keep a backup of "work" in ${join(dir, ".backups")}? [Y/n] `;

test("--remove asks first in a terminal: anything but y keeps the space, without the backup question", async () => {
	for (const input of ["n\n", "\n", ""]) {
		const r = await run(["--remove", "work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.out, `${removeQuestion(r.dir)}Kept space "work".\n`);
		assert.equal(r.err, "");
		assert.deepEqual(r.left, ["work"]);
		assert.deepEqual(r.backups, []);
	}
});

test("--remove then asks about a backup: Enter, y or the end of input keep one; n deletes without one", async () => {
	// Both answers arrive in one chunk, as when pasted or piped: the second one must not be lost.
	for (const input of ["y\n\n", "YES\ny\n", "y\nYes\n", "y\n"]) {
		const r = await run(["--remove", "work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.backups.length, 1, JSON.stringify(input));
		assert.equal(
			r.out,
			`${removeQuestion(r.dir)}${backupQuestion(r.dir)}Removed space "work"; its backup is ${join(r.dir, ".backups", r.backups[0])}.\n`,
		);
		assert.deepEqual(r.left, []);
	}
	for (const input of ["y\nn\n", "y\nNO\n"]) {
		const r = await run(["--remove", "work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.out, `${removeQuestion(r.dir)}${backupQuestion(r.dir)}Removed space "work".\n`);
		assert.deepEqual(r.left, []);
		assert.deepEqual(r.backups, []);
	}
});

test("--remove --no-backup in a terminal asks only the first question", async () => {
	const r = await run(["--remove", "work", "--no-backup"], { spaces: ["work"], tty: true, input: "y\n" });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, `${removeQuestion(r.dir)}Removed space "work".\n`);
	assert.deepEqual(r.left, []);
	assert.deepEqual(r.backups, []);
});

test("--remove without a terminal and without --yes refuses with exit 1 and keeps the space", async () => {
	const r = await run(["--remove", "work"], { spaces: ["work"], tty: false });
	assert.equal(r.code, 1);
	assert.equal(r.out, "");
	assert.equal(r.err, 'pi-space: Removing a space needs confirmation; run pi-space --remove work --yes.\n');
	assert.deepEqual(r.left, ["work"]);
});

test("--remove refuses a missing, reserved, invalid or active space with exit 1, before asking", async () => {
	const cases: [string, Parameters<typeof run>[1], RegExp | string][] = [
		["ghost", { spaces: ["work"] }, 'pi-space: Space "ghost" does not exist.\n'],
		["base", { spaces: ["work"] }, /^pi-space: "base" is reserved/],
		["Bad Name", { spaces: ["work"] }, /^pi-space: Invalid space name "Bad Name"/],
		["work", { spaces: ["work"], env: { PI_CODING_AGENT_DIR: "<root>/spaces/work" } }, 'pi-space: Space "work" is active; switch to another space before removing it.\n'],
	];
	for (const [name, options, err] of cases) {
		const r = await run(["--remove", name], { ...options, tty: true, input: "y\n" });
		assert.equal(r.code, 1, name);
		assert.equal(r.out, "", name);
		if (typeof err === "string") assert.equal(r.err, err);
		else assert.match(r.err, err);
		assert.deepEqual(r.left, ["work"], name);
	}
});

test("--remove protects the base home when run from inside a space", async () => {
	const r = await run(["--remove", "agent", "--yes"], {
		spaces: ["agent", "work"],
		env: { PI_CODING_AGENT_DIR: "<root>/spaces/work", PI_SPACES_BASE_HOME: "<root>/spaces/agent" },
	});
	assert.equal(r.code, 1);
	assert.equal(r.err, `pi-space: Space "agent" holds the base home ${join(r.dir, "agent")}; it cannot be removed.\n`);
	assert.deepEqual(r.left, ["agent", "work"]);
});

test("--remove without exactly one name prints the usage to stderr and exits 2", async () => {
	const r = await run(["--remove", "a", "b"], { spaces: ["a", "b"] });
	assert.equal(r.code, 2);
	assert.equal(r.err, USAGE);
	assert.deepEqual(r.left, ["a", "b"]);
});

test("--command runs that program for this call instead of PI_SPACES_COMMAND", async () => {
	const r = await run(["--command", "my-launcher --", "work", "-c"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "other" } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--", "--space", "work", "-c"] }]);
	assert.equal(r.spawned[0].options.env, undefined);
});

test("--dir uses that spaces folder instead of PI_SPACES_DIR, and the started Pi gets it as PI_SPACES_DIR", async () => {
	const env = { PI_SPACES_DIR: "<root>/elsewhere", PI_CODING_AGENT_DIR: "/some/home" };
	const launched = await run(["--dir", "<root>/spaces", "work"], { spaces: ["work"], env });
	assert.equal(launched.code, 0, launched.err);
	assert.deepEqual(launched.spawned[0].args, ["--space", "work"]);
	const childEnv = launched.spawned[0].options.env as Record<string, string>;
	assert.equal(childEnv.PI_SPACES_DIR, launched.dir);
	assert.equal(childEnv.PI_CODING_AGENT_DIR, "/some/home");

	const listed = await run(["--dir", "<root>/spaces", "list"], { spaces: ["work"], env });
	assert.equal(listed.out, `Spaces in ${listed.dir}:\n  base\n  work\n`);

	const created = await run(["--dir", "<root>/spaces", "--new", "fresh"], { env });
	assert.equal(created.code, 0, created.err);
	assert.deepEqual(created.left, ["fresh"]);

	const removed = await run(["--dir", "<root>/spaces", "--remove", "work", "--yes"], { spaces: ["work"], env });
	assert.equal(removed.code, 0, removed.err);
	assert.deepEqual(removed.left, []);
	assert.equal(removed.backups.length, 1);
});

test("--command or --dir without a value prints the usage to stderr, exits 2 and spawns nothing", async () => {
	for (const argv of [["--command"], ["--dir"]]) {
		const r = await run(argv, { spaces: ["work"] });
		assert.equal(r.code, 2);
		assert.equal(r.err, USAGE);
		assert.equal(r.spawned.length, 0);
	}
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

test("bin/pi-space.mjs --dir and --command reach the real child: its PI_SPACES_DIR is that folder, the rest of its env is untouched", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(join(dir, "work"), { recursive: true });
		const script = join(root, "fake.mjs");
		writeFileSync(
			script,
			"console.log(JSON.stringify({ argv: process.argv.slice(2), dir: process.env.PI_SPACES_DIR, home: process.env.PI_CODING_AGENT_DIR, command: process.env.PI_SPACES_COMMAND })); process.exit(3);\n",
		);
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const result = spawnSync(process.execPath, [bin, "--command", `${process.execPath} ${script}`, "--dir", dir, "work", "-c"], {
			encoding: "utf8",
			env: { ...process.env, PI_SPACES_DIR: join(root, "elsewhere"), PI_SPACES_COMMAND: "not-run", PI_CODING_AGENT_DIR: "/some/home" },
		});
		assert.equal(result.status, 3, result.stderr);
		const seen = JSON.parse(result.stdout);
		assert.deepEqual(seen.argv, ["--space", "work", "-c"]);
		assert.equal(seen.dir, dir);
		assert.equal(seen.home, "/some/home");
		// --command is for this call only: the child keeps the shell's value.
		assert.equal(seen.command, "not-run");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
