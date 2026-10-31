import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchCommand, main, parseCli, setupCommand, splitCommand, type CliIo } from "../src/cli.ts";

const USAGE = `Usage: pi-space [--command <cmd>] [--dir <path>] [--setup <cmd>] [<name> [pi args...] | <command> ...]
       pi-space --help | --version
  pi-space                                    pick a space and start Pi in it
  pi-space <name> [pi args...]                start Pi in a space ("base" for the home Pi starts with)
  pi-space list                               list the spaces
  pi-space list <name|--every>                list the packages of a space
  pi-space new <name>                         create a space, then run the setup command in it when there is one
  pi-space setup <name|--every>               run the setup command in a space, or in every space (never in base)
  pi-space rename <old> <new>                 rename a space
  pi-space remove <name>                      delete a space and everything in it, after asking, and keep a backup in .backups unless told not to
                                              (--yes skips the questions; --no-backup deletes without a backup)
  pi-space update <name|--every>              update the packages of a space (more words go to Pi: --extensions, --all, a source)
  pi-space install <name|--every> <source>    install a package in a space (more words go to Pi)
  pi-space uninstall <name|--every> <source>  remove a package from a space (more words go to Pi)
  pi-space --help                             print this help
  pi-space --version                          print the version
  --every takes the place of the name: base first (not for setup), then every space in turn; a failure does not stop the rest, and the exit status is 1 if any failed.
Options before the command, for this call only:
  --command <cmd>                             the program to run instead of $PI_SPACES_COMMAND (default: pi), e.g. "my-launcher --"
  --dir <path>                                the spaces folder instead of $PI_SPACES_DIR; the Pi it starts gets it too
  --setup <cmd>                               the setup command instead of $PI_SPACES_SETUP; {home} and {name} become the space's folder and name
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
		/** Exit status of the spawned Pi by the space named after --space, else `status`. */
		statuses?: Record<string, number>;
		/** Make a spawn that cannot start, by the space named after --space. */
		spawnErrors?: Record<string, string>;
		/** Write "ran <space>" to stdout at each spawn, to see how it interleaves with the headers. */
		echo?: boolean;
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
		// A path written with "/" after <root> is normalized, so it reads the same as join() gives on Windows.
		const fill = (text: string) => (text.includes("<root>") ? normalize(text.replace("<root>", root)) : text);
		const env = Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, fill(value)]));
		const result: Run = { code: undefined, out: "", err: "", spawned: [], dir, settings: {}, left: [], backups: [], root };
		const io: CliIo = {
			stdin,
			stdout: { write: (text: string) => void (result.out += text) },
			stderr: { write: (text: string) => void (result.err += text) },
			env: { PI_SPACES_DIR: dir, PI_CODING_AGENT_DIR: join(root, "no-agent"), ...env },
			home: root,
			spawn: async (program, args, spawnOptions) => {
				result.spawned.push({ program, args, options: spawnOptions });
				// A setup command has no --space: its space is in PI_SPACE.
				const target = args.includes("--space") ? args[args.indexOf("--space") + 1] : (spawnOptions.env?.PI_SPACE ?? "");
				if (options.echo) result.out += `ran ${target}\n`;
				const failure = options.spawnErrors?.[target] ?? options.spawnError;
				return failure ? { status: null, error: new Error(failure) } : { status: options.statuses?.[target] ?? options.status ?? 0 };
			},
			exit: (code) => void (result.code = code),
		};
		if (options.readOnly) chmodSync(dir, 0o555);
		try {
			await main(argv.map(fill), io);
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

test("parseCli: a name launches with the rest of the arguments", () => {
	assert.deepEqual(parseCli(["work", "-c", "hello"]), { kind: "launch", name: "work", args: ["-c", "hello"] });
	assert.deepEqual(parseCli(["base"]), { kind: "launch", name: "base", args: [] });
});

test("parseCli: list alone lists the spaces; list <name> and list --every list packages", () => {
	assert.deepEqual(parseCli(["list"]), { kind: "list" });
	assert.deepEqual(parseCli(["list", "work"]), { kind: "packages", verb: "list", target: { name: "work" }, args: [] });
	assert.deepEqual(parseCli(["list", "base"]), { kind: "packages", verb: "list", target: { name: "base" }, args: [] });
	assert.deepEqual(parseCli(["list", "--every"]), { kind: "packages", verb: "list", target: { every: true }, args: [] });
	assert.deepEqual(parseCli(["list", "a", "b"]), { kind: "usage" });
	assert.deepEqual(parseCli(["list", "--every", "x"]), { kind: "usage" });
	assert.deepEqual(parseCli(["list", "--bogus"]), { kind: "unknown-option", option: "--bogus" });
});

test("parseCli: new takes exactly one name", () => {
	assert.deepEqual(parseCli(["new", "work"]), { kind: "new", name: "work" });
	assert.deepEqual(parseCli(["new"]), { kind: "usage" });
	assert.deepEqual(parseCli(["new", "a", "b"]), { kind: "usage" });
});

test("parseCli: rename takes exactly two names", () => {
	assert.deepEqual(parseCli(["rename", "old", "fresh"]), { kind: "rename", from: "old", to: "fresh" });
	for (const argv of [["rename"], ["rename", "a"], ["rename", "a", "b", "c"]]) {
		assert.deepEqual(parseCli(argv), { kind: "usage" }, argv.join(" "));
	}
});

test("parseCli: remove takes one name, with --yes (-y) and --no-backup on either side; --delete is not an option", () => {
	assert.deepEqual(parseCli(["remove", "work"]), { kind: "remove", name: "work", yes: false, backup: true });
	assert.deepEqual(parseCli(["remove", "work", "--yes"]), { kind: "remove", name: "work", yes: true, backup: true });
	assert.deepEqual(parseCli(["remove", "-y", "work"]), { kind: "remove", name: "work", yes: true, backup: true });
	assert.deepEqual(parseCli(["remove", "--no-backup", "work", "--yes"]), { kind: "remove", name: "work", yes: true, backup: false });
	assert.deepEqual(parseCli(["--delete", "work"]), { kind: "unknown-option", option: "--delete" });
	for (const argv of [
		["remove"],
		["remove", "--yes"],
		["remove", "a", "b"],
		["remove", "a", "--yes", "b"],
		["remove", "a", "--yes", "-y"],
		["remove", "a", "--no-backup", "--no-backup"],
		["remove", "a", "--backup"],
	]) {
		assert.deepEqual(parseCli(argv), { kind: "usage" }, argv.join(" "));
	}
});

test("parseCli: update takes a name or --every, then Pi's options as they are; nothing after the name is allowed", () => {
	assert.deepEqual(parseCli(["update", "work"]), { kind: "packages", verb: "update", target: { name: "work" }, args: [] });
	assert.deepEqual(parseCli(["update", "work", "--extensions"]), { kind: "packages", verb: "update", target: { name: "work" }, args: ["--extensions"] });
	assert.deepEqual(parseCli(["update", "--every", "--all", "npm:x"]), { kind: "packages", verb: "update", target: { every: true }, args: ["--all", "npm:x"] });
	assert.deepEqual(parseCli(["update"]), { kind: "usage" });
	assert.deepEqual(parseCli(["update", "--extensions"]), { kind: "unknown-option", option: "--extensions" });
});

test("parseCli: install and uninstall take a name or --every and a source, then Pi's options", () => {
	for (const verb of ["install", "uninstall"] as const) {
		assert.deepEqual(parseCli([verb, "work", "npm:x"]), { kind: "packages", verb, target: { name: "work" }, args: ["npm:x"] });
		assert.deepEqual(parseCli([verb, "--every", "npm:x", "-l"]), { kind: "packages", verb, target: { every: true }, args: ["npm:x", "-l"] });
		assert.deepEqual(parseCli([verb, "work"]), { kind: "usage" }, verb);
		assert.deepEqual(parseCli([verb, "--every"]), { kind: "usage" }, verb);
		assert.deepEqual(parseCli([verb]), { kind: "usage" }, verb);
	}
});

test("parseCli: --new and --remove were replaced by the commands new and remove", () => {
	assert.deepEqual(parseCli(["--new", "x"]), { kind: "replaced", option: "--new", instead: "pi-space new <name>" });
	assert.deepEqual(parseCli(["--remove", "x", "--yes"]), { kind: "replaced", option: "--remove", instead: "pi-space remove <name> [--yes] [--no-backup]" });
	assert.deepEqual(parseCli(["--dir", "/d", "--new"]), { kind: "replaced", option: "--new", instead: "pi-space new <name>", dir: "/d" });
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
	assert.deepEqual(parseCli(["--dir", "/d", "new", "x"]), { kind: "new", name: "x", dir: "/d" });
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

test("parseCli: --help after a name belongs to Pi", () => {
	assert.deepEqual(parseCli(["work", "--help"]), { kind: "launch", name: "work", args: ["--help"] });
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

test("launchCommand: quotes keep a program path with spaces in one word", () => {
	assert.deepEqual(launchCommand({ PI_SPACES_COMMAND: '"/opt/my launcher/run" --' }, "work", []), {
		program: "/opt/my launcher/run",
		args: ["--", "--space", "work"],
	});
});

test("splitCommand: plain words, extra whitespace and blank text", () => {
	assert.deepEqual(splitCommand("my-launcher --"), ["my-launcher", "--"]);
	assert.deepEqual(splitCommand("  my-launcher \t  --\n "), ["my-launcher", "--"]);
	assert.deepEqual(splitCommand(""), []);
	assert.deepEqual(splitCommand("  \t "), []);
});

test("splitCommand: double and single quotes keep whitespace in one word and are removed", () => {
	assert.deepEqual(splitCommand('"/opt/my launcher/run" --'), ["/opt/my launcher/run", "--"]);
	assert.deepEqual(splitCommand("'/opt/my launcher/run' --"), ["/opt/my launcher/run", "--"]);
});

test("splitCommand: quotes join adjacent text into one word", () => {
	assert.deepEqual(splitCommand('a"b c"d'), ["ab cd"]);
	assert.deepEqual(splitCommand("a'b c'd e"), ["ab cd", "e"]);
});

test("splitCommand: an empty pair is an empty word only on its own", () => {
	assert.deepEqual(splitCommand('x "" y'), ["x", "", "y"]);
	assert.deepEqual(splitCommand("x '' y"), ["x", "", "y"]);
	assert.deepEqual(splitCommand('x a"" y'), ["x", "a", "y"]);
});

test("splitCommand: there are no backslash escapes, so a Windows path in quotes keeps its backslashes", () => {
	assert.deepEqual(splitCommand('"C:\\Program Files\\x.exe" --'), ["C:\\Program Files\\x.exe", "--"]);
	assert.deepEqual(splitCommand("C:\\bin\\x.exe a\\ b"), ["C:\\bin\\x.exe", "a\\", "b"]);
});

test("splitCommand: the other kind of quote inside a quote is a plain character", () => {
	assert.deepEqual(splitCommand(`"it's here" x`), ["it's here", "x"]);
	assert.deepEqual(splitCommand(`'say "hi" now' x`), ['say "hi" now', "x"]);
});

test("splitCommand: an unclosed quote is an error that names the quote", () => {
	assert.throws(() => splitCommand('"/opt/my launcher/run --'), { message: 'the command has an unclosed " quote' });
	assert.throws(() => splitCommand("run 'a b"), { message: "the command has an unclosed ' quote" });
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
	assert.equal(none.out, `Spaces in ${none.dir}:\n  base\nNo spaces yet. Create one with pi-space new <name>.\n`);
});

test("list with more than one word prints the usage to stderr and exits 2", async () => {
	const r = await run(["list", "a", "extra"]);
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

test("new creates the space with npm:@jals1212/pi-spaces when the base home does not declare it, and spawns nothing", async () => {
	const r = await run(["new", "work"]);
	assert.equal(r.code, 0);
	assert.equal(r.out, `Created space "work" at ${join(r.dir, "work")}.\nStart Pi in it with: pi-space work\n`);
	assert.equal(r.err, "");
	assert.deepEqual(r.settings, { work: { packages: ["npm:@jals1212/pi-spaces"] } });
	assert.equal(r.spawned.length, 0);
});

test("new copies the base home's declaration of the extension, as /space new does", async () => {
	const declaration = { source: "npm:@jals1212/pi-spaces@0.1.1", extensions: ["extensions/spaces.ts"] };
	const r = await run(["new", "work"], { basePackages: ["npm:other", declaration], env: { PI_CODING_AGENT_DIR: "<root>/agent" } });
	assert.equal(r.code, 0);
	assert.deepEqual(r.settings.work, { packages: [declaration] });
	const fromSpace = await run(["new", "work"], {
		basePackages: ["git:github.com/jals1212/pi-spaces"],
		env: { PI_CODING_AGENT_DIR: "<root>/spaces/other", PI_SPACES_BASE_HOME: "<root>/agent" },
	});
	assert.deepEqual(fromSpace.settings.work, { packages: ["git:github.com/jals1212/pi-spaces"] });
});

test("new copies a local path to another copy of the extension from the base home", async () => {
	const r = await run(["new", "work"], {
		checkout: true,
		basePackages: [{ source: "../checkout", extensions: ["extensions/spaces.ts"] }],
		env: { PI_CODING_AGENT_DIR: "<root>/agent" },
	});
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.settings.work, { packages: [{ source: join(r.root, "checkout"), extensions: ["extensions/spaces.ts"] }] });
});

test("new copies the local path the base home loads the extension from, when it is the folder this command resolves", async () => {
	const packageRoot = dirname(fileURLToPath(import.meta.resolve("@jals1212/pi-spaces/package.json")));
	const r = await run(["new", "work"], { basePackages: [packageRoot], env: { PI_CODING_AGENT_DIR: "<root>/agent" } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.settings.work, { packages: [packageRoot] });
});

test("new refuses a taken, reserved or invalid name with exit 1", async () => {
	const taken = await run(["new", "work"], { spaces: ["work"] });
	assert.equal(taken.code, 1);
	assert.equal(taken.err, 'pi-space: Space "work" already exists.\n');
	assert.deepEqual(taken.settings, {});
	const reserved = await run(["new", "base"]);
	assert.equal(reserved.code, 1);
	assert.match(reserved.err, /^pi-space: "base" is reserved/);
	const invalid = await run(["new", "Bad Name"]);
	assert.equal(invalid.code, 1);
	assert.match(invalid.err, /^pi-space: Invalid space name "Bad Name"/);
});

test("new without exactly one name prints the usage to stderr and exits 2", async () => {
	for (const argv of [["new"], ["new", "a", "b"]]) {
		const r = await run(argv);
		assert.equal(r.code, 2);
		assert.equal(r.err, USAGE);
		assert.deepEqual(r.settings, {});
	}
});

test("remove --yes keeps a backup in .backups and leaves the other spaces", async () => {
	const r = await run(["remove", "work", "--yes"], { spaces: ["work", "other"] });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.backups.length, 1);
	assert.match(r.backups[0], /^work-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
	assert.equal(r.out, `Removed space "work"; its backup is ${join(r.dir, ".backups", r.backups[0])}.\n`);
	assert.equal(r.err, "");
	assert.deepEqual(r.left, ["other"]);
	assert.equal(r.spawned.length, 0);
});

test("remove --yes reports a backup that cannot be written with exit 1 and keeps the space", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
	const r = await run(["remove", "work", "--yes"], { spaces: ["work"], readOnly: true });
	assert.equal(r.code, 1);
	assert.match(r.err, /^pi-space: Could not back up space "work": .*EACCES.*\. The space was not removed; fix that, or remove it without a backup with --no-backup\.\n$/);
	assert.equal(r.out, "");
	assert.deepEqual(r.left, ["work"]);
	assert.deepEqual(r.backups, []);
});

test("remove --yes --no-backup deletes without a backup", async () => {
	const r = await run(["remove", "work", "--yes", "--no-backup"], { spaces: ["work", "other"] });
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

test("remove asks first in a terminal: anything but y keeps the space, without the backup question", async () => {
	for (const input of ["n\n", "\n", ""]) {
		const r = await run(["remove", "work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.out, `${removeQuestion(r.dir)}Kept space "work".\n`);
		assert.equal(r.err, "");
		assert.deepEqual(r.left, ["work"]);
		assert.deepEqual(r.backups, []);
	}
});

test("remove then asks about a backup: Enter, y or the end of input keep one; n deletes without one", async () => {
	// Both answers arrive in one chunk, as when pasted or piped: the second one must not be lost.
	for (const input of ["y\n\n", "YES\ny\n", "y\nYes\n", "y\n"]) {
		const r = await run(["remove", "work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.backups.length, 1, JSON.stringify(input));
		assert.equal(
			r.out,
			`${removeQuestion(r.dir)}${backupQuestion(r.dir)}Removed space "work"; its backup is ${join(r.dir, ".backups", r.backups[0])}.\n`,
		);
		assert.deepEqual(r.left, []);
	}
	for (const input of ["y\nn\n", "y\nNO\n"]) {
		const r = await run(["remove", "work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.out, `${removeQuestion(r.dir)}${backupQuestion(r.dir)}Removed space "work".\n`);
		assert.deepEqual(r.left, []);
		assert.deepEqual(r.backups, []);
	}
});

test("remove --no-backup in a terminal asks only the first question", async () => {
	const r = await run(["remove", "work", "--no-backup"], { spaces: ["work"], tty: true, input: "y\n" });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, `${removeQuestion(r.dir)}Removed space "work".\n`);
	assert.deepEqual(r.left, []);
	assert.deepEqual(r.backups, []);
});

test("remove without a terminal and without --yes refuses with exit 1 and keeps the space", async () => {
	const r = await run(["remove", "work"], { spaces: ["work"], tty: false });
	assert.equal(r.code, 1);
	assert.equal(r.out, "");
	assert.equal(r.err, 'pi-space: Removing a space needs confirmation; run pi-space remove work --yes.\n');
	assert.deepEqual(r.left, ["work"]);
});

test("remove refuses a missing, reserved, invalid or active space with exit 1, before asking", async () => {
	const cases: [string, Parameters<typeof run>[1], RegExp | string][] = [
		["ghost", { spaces: ["work"] }, 'pi-space: Space "ghost" does not exist.\n'],
		["base", { spaces: ["work"] }, /^pi-space: "base" is reserved/],
		["Bad Name", { spaces: ["work"] }, /^pi-space: Invalid space name "Bad Name"/],
		["work", { spaces: ["work"], env: { PI_CODING_AGENT_DIR: "<root>/spaces/work" } }, 'pi-space: Space "work" is active; switch to another space before removing it.\n'],
	];
	for (const [name, options, err] of cases) {
		const r = await run(["remove", name], { ...options, tty: true, input: "y\n" });
		assert.equal(r.code, 1, name);
		assert.equal(r.out, "", name);
		if (typeof err === "string") assert.equal(r.err, err);
		else assert.match(r.err, err);
		assert.deepEqual(r.left, ["work"], name);
	}
});

test("remove protects the base home when run from inside a space", async () => {
	const r = await run(["remove", "agent", "--yes"], {
		spaces: ["agent", "work"],
		env: { PI_CODING_AGENT_DIR: "<root>/spaces/work", PI_SPACES_BASE_HOME: "<root>/spaces/agent" },
	});
	assert.equal(r.code, 1);
	assert.equal(r.err, `pi-space: Space "agent" holds the base home ${join(r.dir, "agent")}; it cannot be removed.\n`);
	assert.deepEqual(r.left, ["agent", "work"]);
});

test("remove without exactly one name prints the usage to stderr and exits 2", async () => {
	const r = await run(["remove", "a", "b"], { spaces: ["a", "b"] });
	assert.equal(r.code, 2);
	assert.equal(r.err, USAGE);
	assert.deepEqual(r.left, ["a", "b"]);
});

test("rename moves the space, keeps its settings and spawns nothing", async () => {
	const r = await run(["rename", "work", "job"], { spaces: ["work", "other"] });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, 'Renamed space "work" to "job".\n');
	assert.equal(r.err, "");
	assert.deepEqual(r.left, ["job", "other"]);
	assert.equal(r.spawned.length, 0);
});

test("rename refuses a missing, taken, reserved, invalid or active space with exit 1 and changes nothing", async () => {
	const cases: [string[], Parameters<typeof run>[1], RegExp | string][] = [
		[["ghost", "x"], { spaces: ["work"] }, 'pi-space: Space "ghost" does not exist.\n'],
		[["work", "other"], { spaces: ["work", "other"] }, 'pi-space: Space "other" already exists.\n'],
		[["work", "base"], { spaces: ["work"] }, /^pi-space: "base" is reserved/],
		[["work", "list"], { spaces: ["work"] }, /^pi-space: "list" is reserved/],
		[["work", "Bad Name"], { spaces: ["work"] }, /^pi-space: Invalid space name "Bad Name"/],
		[["work", "x"], { spaces: ["work"], env: { PI_CODING_AGENT_DIR: "<root>/spaces/work" } }, 'pi-space: Space "work" is active; switch to another space before renaming it.\n'],
	];
	for (const [names, options, err] of cases) {
		const r = await run(["rename", ...names], options);
		assert.equal(r.code, 1, names.join(" "));
		assert.equal(r.out, "", names.join(" "));
		if (typeof err === "string") assert.equal(r.err, err);
		else assert.match(r.err, err);
		assert.deepEqual(r.left, [...(options.spaces ?? [])].sort(), names.join(" "));
	}
});

test("rename without exactly two names prints the usage to stderr and exits 2", async () => {
	for (const argv of [["rename"], ["rename", "a"], ["rename", "a", "b", "c"]]) {
		const r = await run(argv, { spaces: ["a"] });
		assert.equal(r.code, 2);
		assert.equal(r.err, USAGE);
		assert.deepEqual(r.left, ["a"]);
	}
});

test("--new and --remove say what replaced them, exit 2 and change nothing", async () => {
	const created = await run(["--new", "x"]);
	assert.equal(created.code, 2);
	assert.equal(created.out, "");
	assert.equal(created.err, "pi-space: --new was replaced by: pi-space new <name>\n");
	assert.deepEqual(created.left, []);
	const removed = await run(["--remove", "work", "--yes"], { spaces: ["work"] });
	assert.equal(removed.code, 2);
	assert.equal(removed.out, "");
	assert.equal(removed.err, "pi-space: --remove was replaced by: pi-space remove <name> [--yes] [--no-backup]\n");
	assert.deepEqual(removed.left, ["work"]);
	assert.equal(removed.spawned.length, 0);
});

test("list <name> runs Pi's list in that space through the extension, with inherited stdio and Pi's exit status", async () => {
	const r = await run(["list", "work"], { spaces: ["work"], status: 4, env: { PI_CODING_AGENT_DIR: "/some/home" } });
	assert.equal(r.code, 4);
	assert.equal(r.out, "");
	assert.equal(r.err, "");
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "pi", args: ["--space", "work", "list"] }]);
	assert.deepEqual(r.spawned[0].options, { stdio: "inherit" });
});

test("update, install and uninstall run `--space <name> <command> <args>` through PI_SPACES_COMMAND and --command", async () => {
	const update = await run(["update", "work", "--extensions"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "my-launcher --" } });
	assert.equal(update.code, 0, update.err);
	assert.deepEqual(update.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--", "--space", "work", "update", "--extensions"] }]);
	const install = await run(["--command", '"/opt/my launcher/run" --', "install", "work", "npm:x@1", "-l"], { spaces: ["work"] });
	assert.equal(install.code, 0, install.err);
	assert.deepEqual(install.spawned.map(({ program, args }) => ({ program, args })), [
		{ program: "/opt/my launcher/run", args: ["--", "--space", "work", "install", "npm:x@1", "-l"] },
	]);
	const uninstall = await run(["uninstall", "base", "npm:x"]);
	assert.deepEqual(uninstall.spawned.map(({ args }) => args), [["--space", "base", "uninstall", "npm:x"]]);
	const bare = await run(["update", "work"], { spaces: ["work"] });
	assert.deepEqual(bare.spawned.map(({ args }) => args), [["--space", "work", "update"]]);
});

test("a package command returns the exit status of Pi", async () => {
	const r = await run(["install", "work", "npm:x"], { spaces: ["work"], status: 9 });
	assert.equal(r.code, 9);
});

test("a package command never sets PI_CODING_AGENT_DIR, and --dir reaches the child as PI_SPACES_DIR", async () => {
	const env = { PI_SPACES_DIR: "<root>/elsewhere", PI_CODING_AGENT_DIR: "/some/home" };
	const plain = await run(["update", "work"], { spaces: ["work"], env: { PI_CODING_AGENT_DIR: "/some/home" } });
	assert.equal(plain.spawned[0].options.env, undefined);
	const withDir = await run(["--dir", "<root>/spaces", "update", "work"], { spaces: ["work"], env });
	const childEnv = withDir.spawned[0].options.env as Record<string, string>;
	assert.equal(childEnv.PI_SPACES_DIR, withDir.dir);
	assert.equal(childEnv.PI_CODING_AGENT_DIR, "/some/home");
});

test("a package command in an unknown or invalid space exits 1 and spawns nothing", async () => {
	for (const verb of ["list", "update", "install", "uninstall"]) {
		const ghost = await run(verb === "list" || verb === "update" ? [verb, "ghost"] : [verb, "ghost", "npm:x"], { spaces: ["work"] });
		assert.equal(ghost.code, 1, verb);
		assert.equal(ghost.out, "", verb);
		assert.equal(ghost.err, 'pi-space: Space "ghost" does not exist.\n', verb);
		assert.equal(ghost.spawned.length, 0, verb);
	}
	const invalid = await run(["update", "Bad Name"]);
	assert.equal(invalid.code, 1);
	assert.match(invalid.err, /^pi-space: Invalid space name "Bad Name"/);
	assert.equal(invalid.spawned.length, 0);
});

test("install and uninstall without a source print the usage to stderr, exit 2 and spawn nothing", async () => {
	for (const argv of [["install", "work"], ["uninstall", "work"], ["install", "--every"], ["uninstall"], ["update"]]) {
		const r = await run(argv, { spaces: ["work"] });
		assert.equal(r.code, 2, argv.join(" "));
		assert.equal(r.out, "", argv.join(" "));
		assert.equal(r.err, USAGE, argv.join(" "));
		assert.equal(r.spawned.length, 0, argv.join(" "));
	}
});

test("a package command with an unclosed quote in the command exits 2 naming its source and spawns nothing", async () => {
	const one = await run(["update", "work"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "run 'a b" } });
	assert.equal(one.code, 2);
	assert.equal(one.err, "pi-space: PI_SPACES_COMMAND: the command has an unclosed ' quote.\n");
	assert.equal(one.spawned.length, 0);
	const every = await run(["--command", '"x', "update", "--every"], { spaces: ["work"] });
	assert.equal(every.code, 2);
	assert.equal(every.out, "");
	assert.equal(every.err, 'pi-space: --command: the command has an unclosed " quote.\n');
	assert.equal(every.spawned.length, 0);
});

test("a package command whose program cannot start prints the reason and exits 1", async () => {
	const r = await run(["update", "work"], { spaces: ["work"], spawnError: "spawn pi ENOENT" });
	assert.equal(r.code, 1);
	assert.equal(r.err, "pi-space: could not start pi: spawn pi ENOENT\n");
});

test("--every runs base first, then every space in order, one at a time, each after its header", async () => {
	const r = await run(["update", "--every", "--extensions"], { spaces: ["work", "alpha"], echo: true });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, "== base\nran base\n== alpha\nran alpha\n== work\nran work\n");
	assert.equal(r.err, "");
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [
		{ program: "pi", args: ["--space", "base", "update", "--extensions"] },
		{ program: "pi", args: ["--space", "alpha", "update", "--extensions"] },
		{ program: "pi", args: ["--space", "work", "update", "--extensions"] },
	]);
	for (const spawned of r.spawned) assert.deepEqual(spawned.options, { stdio: "inherit" });
});

test("--every works for list, install and uninstall, and with no spaces it runs only base", async () => {
	const listed = await run(["list", "--every"], { spaces: ["work"] });
	assert.deepEqual(listed.spawned.map(({ args }) => args), [["--space", "base", "list"], ["--space", "work", "list"]]);
	const installed = await run(["install", "--every", "npm:x"], { spaces: ["work"] });
	assert.deepEqual(installed.spawned.map(({ args }) => args), [["--space", "base", "install", "npm:x"], ["--space", "work", "install", "npm:x"]]);
	const removed = await run(["uninstall", "--every", "npm:x"]);
	assert.equal(removed.out, "== base\n");
	assert.deepEqual(removed.spawned.map(({ args }) => args), [["--space", "base", "uninstall", "npm:x"]]);
});

test("--every goes on after a failure, exits 1 and names the failed spaces on the last line of stderr", async () => {
	const r = await run(["update", "--every"], { spaces: ["a", "b", "c"], echo: true, statuses: { base: 3, b: 1 } });
	assert.equal(r.code, 1);
	assert.equal(r.out, "== base\nran base\n== a\nran a\n== b\nran b\n== c\nran c\n");
	assert.equal(r.err, "pi-space: update failed in: base, b\n");
	assert.equal(r.spawned.length, 4);
});

test("--every counts a program that cannot start as a failure and names the reason", async () => {
	const r = await run(["install", "--every", "npm:x"], { spaces: ["a", "b"], spawnErrors: { a: "spawn pi ENOENT" } });
	assert.equal(r.code, 1);
	assert.equal(r.err, "pi-space: could not start pi: spawn pi ENOENT\npi-space: install failed in: a\n");
	assert.equal(r.spawned.length, 3);
});

test("--every with --dir hands the folder to every child", async () => {
	const r = await run(["--dir", "<root>/spaces", "update", "--every"], { spaces: ["a"], env: { PI_SPACES_DIR: "<root>/elsewhere" } });
	assert.equal(r.code, 0, r.err);
	for (const spawned of r.spawned) assert.equal((spawned.options.env as Record<string, string>).PI_SPACES_DIR, r.dir);
	assert.equal(r.spawned.length, 2);
});

test("--command runs that program for this call instead of PI_SPACES_COMMAND", async () => {
	const r = await run(["--command", "my-launcher --", "work", "-c"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "other" } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--", "--space", "work", "-c"] }]);
	assert.equal(r.spawned[0].options.env, undefined);
});

test("--command with a quoted path launches that program with the path in one word", async () => {
	const r = await run(["--command", '"/opt/my launcher/run" --', "work"], { spaces: ["work"] });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "/opt/my launcher/run", args: ["--", "--space", "work"] }]);
});

test("an unclosed quote in --command exits 2 naming --command and spawns nothing", async () => {
	const r = await run(["--command", '"/opt/my launcher/run --', "work"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "other" } });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, 'pi-space: --command: the command has an unclosed " quote.\n');
	assert.equal(r.spawned.length, 0);
});

test("an unclosed quote in PI_SPACES_COMMAND exits 2 naming PI_SPACES_COMMAND and spawns nothing", async () => {
	const r = await run(["work"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "run 'a b" } });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, "pi-space: PI_SPACES_COMMAND: the command has an unclosed ' quote.\n");
	assert.equal(r.spawned.length, 0);
});

test("the program and arguments reach spawn exactly as split, with no shell option, on every platform", async () => {
	const r = await run(["--command", '"C:\\Program Files\\x\\launcher.cmd" --', "work", "-p", "hello world", "100%", "C:\\dir with space\\", "a&b"], { spaces: ["work"] });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [
		{ program: "C:\\Program Files\\x\\launcher.cmd", args: ["--", "--space", "work", "-p", "hello world", "100%", "C:\\dir with space\\", "a&b"] },
	]);
	assert.deepEqual(r.spawned[0].options, { stdio: "inherit" });
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

	const created = await run(["--dir", "<root>/spaces", "new", "fresh"], { env });
	assert.equal(created.code, 0, created.err);
	assert.deepEqual(created.left, ["fresh"]);

	const removed = await run(["--dir", "<root>/spaces", "remove", "work", "--yes"], { spaces: ["work"], env });
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

test("picker: a command with an unclosed quote exits 2 before the list is printed or a line is read", async () => {
	const fromOption = await run(["--command", '"/opt/my launcher/run --'], { spaces: ["work"], tty: true, input: "2\n", env: { PI_SPACES_COMMAND: "other" } });
	assert.equal(fromOption.code, 2);
	assert.equal(fromOption.out, "");
	assert.equal(fromOption.err, 'pi-space: --command: the command has an unclosed " quote.\n');
	assert.equal(fromOption.spawned.length, 0);
	const fromEnv = await run([], { spaces: ["work"], tty: true, input: "2\n", env: { PI_SPACES_COMMAND: "run 'a b" } });
	assert.equal(fromEnv.code, 2);
	assert.equal(fromEnv.out, "");
	assert.equal(fromEnv.err, "pi-space: PI_SPACES_COMMAND: the command has an unclosed ' quote.\n");
	assert.equal(fromEnv.spawned.length, 0);
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
		const result = spawnSync(process.execPath, [bin, "--command", `"${process.execPath}" "${script}"`, "--dir", dir, "work", "-c"], {
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
			env: { ...process.env, PI_SPACES_DIR: dir, PI_SPACES_COMMAND: `"${process.execPath}" "${script}"`, PI_CODING_AGENT_DIR: "/some/home" },
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

test("bin/pi-space.mjs runs a launcher whose folder has a space in its name, given with quotes", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(join(dir, "work"), { recursive: true });
		mkdirSync(join(root, "my launcher"));
		const script = join(root, "my launcher", "fake.mjs");
		writeFileSync(script, "console.log(JSON.stringify({ argv: process.argv.slice(2) })); process.exit(5);\n");
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const result = spawnSync(process.execPath, [bin, "--command", `"${process.execPath}" "${script}"`, "--dir", dir, "work"], { encoding: "utf8" });
		assert.equal(result.status, 5, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).argv, ["--space", "work"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bin/pi-space.mjs passes Pi's arguments to the real child as written: spaces, %, a trailing backslash, quotes and cmd.exe characters", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(join(dir, "work"), { recursive: true });
		const script = join(root, "fake.mjs");
		writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const piArgs = ["-p", "hello world", "100%", "%PATH%", "C:\\dir with space\\", 'say "hi"', "a&b|c<d>e^f", "(x)", "!y!"];
		const result = spawnSync(process.execPath, [bin, "--command", `"${process.execPath}" "${script}"`, "--dir", dir, "work", ...piArgs], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), ["--space", "work", ...piArgs]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bin/pi-space.mjs on Windows starts a .cmd shim found on PATH without its extension, as npm installs pi", { skip: process.platform !== "win32" && "npm's .cmd shims exist only on Windows" }, () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(join(dir, "work"), { recursive: true });
		const shims = join(root, "my shims");
		mkdirSync(shims);
		writeFileSync(join(shims, "fake.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
		// The shape of the shim npm writes: the script next to it, with every argument forwarded.
		writeFileSync(join(shims, "fake-pi.cmd"), `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const piArgs = ["-p", "hello world", "%PATH%", "a&b"];
		// Windows names it Path; a copied env would otherwise hold both Path and PATH.
		const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
		const result = spawnSync(process.execPath, [bin, "--command", "fake-pi", "--dir", dir, "work", ...piArgs], {
			encoding: "utf8",
			env: { ...process.env, [pathKey]: `${shims};${process.env[pathKey] ?? ""}` },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), ["--space", "work", ...piArgs]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bin/pi-space.mjs reports a program that does not exist with exit 1", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		mkdirSync(join(root, "spaces", "work"), { recursive: true });
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const result = spawnSync(process.execPath, [bin, "--command", "pi-space-no-such-program", "--dir", join(root, "spaces"), "work"], { encoding: "utf8" });
		assert.equal(result.status, 1);
		// On Windows cmd.exe prints its own "is not recognized" line first; ours follows it.
		assert.match(result.stderr, /^pi-space: could not start pi-space-no-such-program: .*ENOENT/m);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const SETUP = "my-launcher --home {home} setup";

test("parseCli: setup takes one name or --every and nothing else; --setup comes first with the other call options", () => {
	assert.deepEqual(parseCli(["setup", "work"]), { kind: "setup", target: { name: "work" } });
	assert.deepEqual(parseCli(["setup", "--every"]), { kind: "setup", target: { every: true } });
	assert.deepEqual(parseCli(["setup", "-x"]), { kind: "unknown-option", option: "-x" });
	for (const argv of [["setup"], ["setup", "a", "b"], ["setup", "--every", "x"]]) assert.deepEqual(parseCli(argv), { kind: "usage" }, argv.join(" "));
	assert.deepEqual(parseCli(["--setup", SETUP, "--dir", "/d", "new", "w"]), { kind: "new", name: "w", setup: SETUP, dir: "/d" });
	for (const argv of [["--setup"], ["--setup", ""], ["--setup", "a", "--setup", "b"]]) assert.deepEqual(parseCli(argv), { kind: "usage" }, argv.join(" "));
	assert.deepEqual(parseCli(["work", "--setup", "x"]), { kind: "launch", name: "work", args: ["--setup", "x"] });
});

test("setupCommand: splits like --command and puts the space's folder and name in place of {home} and {name} in every word", () => {
	assert.deepEqual(setupCommand(SETUP, "/s/work", "work"), { program: "my-launcher", args: ["--home", "/s/work", "setup"] });
	assert.deepEqual(setupCommand(`env "CFG={home}/my config" run --space={name} {home}`, "/s/my space", "w"), {
		program: "env",
		args: ["CFG=/s/my space/my config", "run", "--space=w", "/s/my space"],
	});
	assert.deepEqual(setupCommand("run {homes} {HOME}", "/h", "n"), { program: "run", args: ["{homes}", "{HOME}"] });
	assert.throws(() => setupCommand("run 'a", "/h", "n"), /unclosed ' quote/);
});

function setupEnvOf(r: Run, index = 0): Record<string, string> {
	return r.spawned[index].options.env as Record<string, string>;
}

test("new runs the setup command in the new space after creating it, with the space as the agent home", async () => {
	for (const [argv, env] of [
		[["--setup", SETUP, "new", "work"], {}],
		[["new", "work"], { PI_SPACES_SETUP: SETUP }],
	] as [string[], Record<string, string>][]) {
		const r = await run(argv, { env: { ...env, PI_CODING_AGENT_DIR: "/some/home", OTHER: "kept" } });
		const home = join(r.dir, "work");
		assert.equal(r.code, 0, r.err);
		assert.equal(r.err, "");
		assert.equal(r.out, `Created space "work" at ${home}.\nSetting it up: my-launcher --home ${home} setup\nStart Pi in it with: pi-space work\n`);
		assert.deepEqual(r.settings, { work: { packages: ["npm:@jals1212/pi-spaces"] } });
		assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--home", home, "setup"] }]);
		assert.equal(r.spawned[0].options.stdio, "inherit");
		const childEnv = setupEnvOf(r);
		assert.equal(childEnv.PI_CODING_AGENT_DIR, home);
		assert.equal(childEnv.PI_SPACE, "work");
		assert.equal(childEnv.PI_SPACE_HOME, home);
		assert.equal(childEnv.PI_SPACES_DIR, r.dir);
		assert.equal(childEnv.PI_SPACES_SETUP, SETUP);
		assert.equal(childEnv.OTHER, "kept");
	}
});

test("new without a setup command, or with a blank one, runs nothing", async () => {
	for (const env of [{}, { PI_SPACES_SETUP: "  " }]) {
		const r = await run(["new", "work"], { env });
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out, `Created space "work" at ${join(r.dir, "work")}.\nStart Pi in it with: pi-space work\n`);
		assert.equal(r.spawned.length, 0);
	}
});

test("new keeps the space when its setup fails, exits with the setup's status and says how to run it again", async () => {
	const failed = await run(["--setup", SETUP, "new", "work"], { status: 5 });
	assert.equal(failed.code, 5);
	assert.deepEqual(failed.left, ["work"]);
	assert.equal(failed.err, 'pi-space: Setup failed in space "work" (exit status 5); the space is kept. Run it again with: pi-space setup work\n');
	const missing = await run(["--setup", SETUP, "new", "work"], { spawnError: "spawn my-launcher ENOENT" });
	assert.equal(missing.code, 1);
	assert.deepEqual(missing.left, ["work"]);
	assert.equal(
		missing.err,
		'pi-space: could not start my-launcher: spawn my-launcher ENOENT\npi-space: Setup failed in space "work" (exit status 1); the space is kept. Run it again with: pi-space setup work\n',
	);
});

test("new with an unclosed quote in the setup command exits 2 naming its source and creates nothing", async () => {
	const option = await run(["--setup", "run 'a", "new", "work"]);
	assert.equal(option.code, 2);
	assert.equal(option.err, "pi-space: --setup: the command has an unclosed ' quote.\n");
	assert.deepEqual(option.left, []);
	const variable = await run(["new", "work"], { env: { PI_SPACES_SETUP: '"x' } });
	assert.equal(variable.code, 2);
	assert.equal(variable.err, 'pi-space: PI_SPACES_SETUP: the command has an unclosed " quote.\n');
	assert.deepEqual(variable.left, []);
	assert.equal(variable.spawned.length, 0);
});

test("setup <name> runs the setup command in that space and exits with its status", async () => {
	const r = await run(["setup", "work"], { spaces: ["work"], status: 3, env: { PI_SPACES_SETUP: SETUP } });
	const home = join(r.dir, "work");
	assert.equal(r.code, 3);
	assert.equal(r.out, "");
	assert.equal(r.err, "");
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--home", home, "setup"] }]);
	assert.equal(setupEnvOf(r).PI_CODING_AGENT_DIR, home);
	assert.equal(setupEnvOf(r).PI_SPACE, "work");
});

test("setup refuses base, an unknown or invalid space with exit 1, and a missing setup command with exit 2, running nothing", async () => {
	const base = await run(["setup", "base"], { env: { PI_SPACES_SETUP: SETUP } });
	assert.equal(base.code, 1);
	assert.equal(base.err, "pi-space: setup runs only in spaces, not in base (the home Pi starts with).\n");
	const ghost = await run(["setup", "ghost"], { spaces: ["work"], env: { PI_SPACES_SETUP: SETUP } });
	assert.equal(ghost.code, 1);
	assert.equal(ghost.err, 'pi-space: Space "ghost" does not exist.\n');
	const invalid = await run(["setup", "Bad Name"], { env: { PI_SPACES_SETUP: SETUP } });
	assert.equal(invalid.code, 1);
	assert.match(invalid.err, /^pi-space: Invalid space name "Bad Name"/);
	for (const env of [{}, { PI_SPACES_SETUP: " " }]) {
		const none = await run(["setup", "work"], { spaces: ["work"], env });
		assert.equal(none.code, 2);
		assert.equal(none.err, "pi-space: There is no setup command; set PI_SPACES_SETUP or give --setup <cmd>.\n");
	}
	const quote = await run(["--setup", "x 'y", "setup", "--every"], { spaces: ["work"] });
	assert.equal(quote.code, 2);
	assert.equal(quote.out, "");
	assert.equal(quote.err, "pi-space: --setup: the command has an unclosed ' quote.\n");
	for (const r of [base, ghost, invalid, quote]) assert.equal(r.spawned.length, 0);
});

test("setup --every runs in every space in order, never in base, goes on after a failure and exits 1 naming the failed ones", async () => {
	const r = await run(["--setup", SETUP, "setup", "--every"], { spaces: ["work", "alpha", "beta"], echo: true, statuses: { beta: 2 } });
	assert.equal(r.code, 1);
	assert.equal(r.out, "== alpha\nran alpha\n== beta\nran beta\n== work\nran work\n");
	assert.equal(r.err, "pi-space: setup failed in: beta\n");
	assert.deepEqual(r.spawned.map(({ args }) => args[1]), ["alpha", "beta", "work"].map((name) => join(r.dir, name)));
	const ok = await run(["--setup", SETUP, "setup", "--every"], { spaces: ["work"] });
	assert.equal(ok.code, 0, ok.err);
	const none = await run(["--setup", SETUP, "setup", "--every"]);
	assert.equal(none.code, 0);
	assert.equal(none.out, "No spaces yet. Create one with pi-space new <name>.\n");
	assert.equal(none.spawned.length, 0);
});

test("--setup reaches the started Pi as PI_SPACES_SETUP, so /space new can name it; nothing else changes", async () => {
	const r = await run(["--setup", SETUP, "work", "-c"], { spaces: ["work"], env: { PI_CODING_AGENT_DIR: "/some/home" } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned[0].args, ["--space", "work", "-c"]);
	assert.equal(setupEnvOf(r).PI_SPACES_SETUP, SETUP);
	assert.equal(setupEnvOf(r).PI_CODING_AGENT_DIR, "/some/home");
	const packages = await run(["--setup", SETUP, "update", "work"], { spaces: ["work"] });
	assert.equal(setupEnvOf(packages).PI_SPACES_SETUP, SETUP);
});
