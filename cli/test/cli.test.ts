import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, normalize, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchCommand, main, parseCli, setupCommand, splitCommand, type CliIo } from "../src/cli.ts";

const USAGE = `Usage: pi-space [--command <cmd>] [--dir <path>] [--setup <cmd>] [--config <path>] [<space> [pi args...] | <command> ...]
       pi-space --help | --version
A <space> is <profile>/<name>: a profile of the config file (pi is always there), then the space; base is a space too, as <profile>/base.
  pi-space                                     pick a space and start Pi in it
  pi-space <space> [pi args...]                start Pi in a space (<profile>/base is the home that profile's Pi starts with)
  pi-space list                                list the spaces of every profile
  pi-space list <space|--every>                list the packages of a space
  pi-space new <space>                         create a space, then run the profile's setup command in it when there is one
  pi-space setup <space|--every>               run the setup command in a space, or in every space (never in base)
  pi-space rename <space> <new>                rename a space; the new name is bare or keeps the profile (<profile>/<new>)
  pi-space remove <space>                      delete a space and everything in it, after asking, and keep a backup in .backups unless told not to
                                               (--yes skips the questions; --no-backup deletes without a backup)
  pi-space update <space|--every>              update the packages of a space (more words go to Pi: --extensions, --all, a source)
  pi-space install <space|--every> <source>    install a package in a space (more words go to Pi)
  pi-space uninstall <space|--every> <source>  remove a package from a space (more words go to Pi)
  pi-space completion zsh                      print the zsh completion script (source <(pi-space completion zsh))
  pi-space completion powershell               print the PowerShell completion script (pi-space completion powershell | Out-String | Invoke-Expression)
  pi-space <command> --help                    the help of one command
  pi-space --help                              print this help
  pi-space --version                           print the version
  --every takes the place of the space: <profile>/--every runs in that profile's base (not for setup) and spaces, --every alone in every profile;
  a failure does not stop the rest, and the exit status is 1 if any failed.
Options before the command, for this call only:
  --command <cmd>                              the program to run instead of the profile's command, e.g. "my-launcher --" (for one profile)
  --dir <path>                                 the spaces folder instead of the profile's; the Pi it starts gets it too (for one profile)
  --setup <cmd>                                the setup command instead of the profile's; {home} and {name} become the space's folder and name
  --config <path>                              the config file instead of $PI_SPACES_CONFIG (default: ~/.pi-spaces/config.json); the Pi it starts gets it too
`;

const SCHEMA = "pi-spaces.config/v1";
/** A home a test passes as PI_CODING_AGENT_DIR: absolute on every platform (and drive), so the CLI hands it on as written. */
const SOME_HOME = join(tmpdir(), "pi-spaces-some-home");
const CONFIG = ".pi-spaces/config.json";

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
		/** Files to write before the run, by path under <root> (the home of the run): objects are written as JSON. */
		files?: Record<string, unknown>;
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
		for (const [path, content] of Object.entries(options.files ?? {})) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
		}
		if (options.basePackages) {
			mkdirSync(join(root, "agent"));
			writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ packages: options.basePackages }));
		}
		// A path written with "/" after <root> is normalized, so it reads the same as join() gives on Windows.
		const fill = (text: string): string => {
			if (!text.includes("<root>")) return text;
			// A JSON object (such as PI_SPACES_BASE_ENV) is filled value by value, so a Windows path stays valid JSON.
			if (text.startsWith("{")) {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				return JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, typeof value === "string" ? fill(value) : value])));
			}
			return normalize(text.replaceAll("<root>", root));
		};
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
	assert.deepEqual(parseCli(["--new", "x"]), { kind: "replaced", option: "--new", instead: "pi-space new <profile>/<name>" });
	assert.deepEqual(parseCli(["--remove", "x", "--yes"]), { kind: "replaced", option: "--remove", instead: "pi-space remove <profile>/<name> [--yes] [--no-backup]" });
	assert.deepEqual(parseCli(["--dir", "/d", "--new"]), { kind: "replaced", option: "--new", instead: "pi-space new <profile>/<name>", dir: "/d" });
	assert.deepEqual(parseCli(["--profile", "ml", "work"]), { kind: "replaced", option: "--profile", instead: "pi-space <profile>/<name>" });
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
	for (const argv of [["--command"], ["--dir"], ["--command", ""], ["--dir", "", "work"], ["--dir", "/a", "--dir", "/b"], ["--command", "x", "--command", "y"], ["--command", "  "], ["--dir", " ", "list"]]) {
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

test("parseCli: --help or -h after a command word, or before one, asks for that command's help", () => {
	for (const command of ["list", "new", "setup", "rename", "remove", "update", "install", "uninstall", "completion"]) {
		const expected = { kind: "command-help", command };
		assert.deepEqual(parseCli([command, "--help"]), expected, command);
		assert.deepEqual(parseCli([command, "-h"]), expected, command);
		assert.deepEqual(parseCli(["--help", command]), expected, command);
		assert.deepEqual(parseCli(["-h", command]), expected, command);
	}
	assert.deepEqual(parseCli(["remove", "work", "--help"]), { kind: "command-help", command: "remove" });
	assert.deepEqual(parseCli(["install", "work", "npm:x", "-h"]), { kind: "command-help", command: "install" });
	assert.deepEqual(parseCli(["--config", "c.json", "list", "--help"]), { kind: "command-help", command: "list", config: "c.json" });
	assert.deepEqual(parseCli(["--help", "ghost"]), { kind: "command-help", command: "ghost" });
	assert.deepEqual(parseCli(["--help", "list", "new"]), { kind: "usage" });
});

test("parseCli: --help alone is the general help, and after a space name or after __complete it is not a command's", () => {
	assert.deepEqual(parseCli(["--help"]), { kind: "help" });
	assert.deepEqual(parseCli(["work", "--help"]), { kind: "launch", name: "work", args: ["--help"] });
	assert.deepEqual(parseCli(["work", "remove", "--help"]), { kind: "launch", name: "work", args: ["remove", "--help"] });
	assert.deepEqual(parseCli(["__complete", "remove", "--help"]), { kind: "complete", words: ["remove", "--help"] });
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

const HELP_USAGE: Record<string, string> = {
	list: "Usage: pi-space list [<space|--every>]",
	new: "Usage: pi-space new <space>",
	setup: "Usage: pi-space setup <space|--every>",
	rename: "Usage: pi-space rename <space> <new>",
	remove: "Usage: pi-space remove <space> [--yes|-y] [--no-backup]",
	update: "Usage: pi-space update <space|--every> [pi args...]",
	install: "Usage: pi-space install <space|--every> <source> [pi args...]",
	uninstall: "Usage: pi-space uninstall <space|--every> <source> [pi args...]",
	completion: "Usage: pi-space completion <shell>",
};

test("<command> --help, -h and --help <command> print that command's help to stdout, exit 0 and do nothing else", async () => {
	// A broken config file would fail any command that read it; a space that exists would be touched by new, remove or rename.
	const files = { [CONFIG]: "{nope" };
	for (const [command, usage] of Object.entries(HELP_USAGE)) {
		const reference = await run([command, "--help"], { spaces: ["work"], files });
		assert.equal(reference.code, 0, command);
		assert.equal(reference.err, "", command);
		assert.equal(reference.spawned.length, 0, command);
		assert.deepEqual(reference.left, ["work"], command);
		assert.equal(reference.out.split("\n")[0], usage, command);
		assert.match(reference.out, /\nExamples:\n {2}pi-space /, command);
		assert.match(reference.out, /--help, -h/, command);
		for (const argv of [[command, "-h"], ["--help", command], ["-h", command]]) {
			const r = await run(argv, { spaces: ["work"], files });
			assert.equal(r.code, 0, argv.join(" "));
			assert.equal(r.out, reference.out, argv.join(" "));
			assert.equal(r.err, "", argv.join(" "));
			assert.equal(r.spawned.length, 0, argv.join(" "));
		}
	}
});

test("--help anywhere after the command word is that command's help: nothing is created, removed or run", async () => {
	const remove = await run(["remove", "pi/work", "--help"], { spaces: ["work"] });
	assert.equal(remove.code, 0);
	assert.match(remove.out, /^Usage: pi-space remove /);
	assert.deepEqual(remove.left, ["work"]);
	assert.deepEqual(remove.backups, []);
	const created = await run(["new", "pi/fresh", "-h"]);
	assert.equal(created.code, 0);
	assert.match(created.out, /^Usage: pi-space new /);
	assert.deepEqual(created.left, []);
	const renamed = await run(["rename", "pi/work", "--help", "other"], { spaces: ["work"] });
	assert.match(renamed.out, /^Usage: pi-space rename /);
	assert.deepEqual(renamed.left, ["work"]);
	const install = await run(["install", "ghost/work", "npm:x", "--help"], { spaces: ["work"] });
	assert.equal(install.code, 0);
	assert.match(install.out, /^Usage: pi-space install /);
	assert.equal(install.err, "");
	assert.equal(install.spawned.length, 0);
});

test("the help of each command says what it takes: arguments, options, the call options that apply, and examples", async () => {
	const help = async (command: string) => (await run([command, "--help"])).out;
	const remove = await help("remove");
	assert.match(remove, /--yes, -y {2,}/);
	assert.match(remove, /--no-backup {2,}/);
	assert.match(remove, /\.backups/);
	for (const verb of ["update", "install", "uninstall"]) {
		const text = await help(verb);
		assert.match(text, /more words go to Pi/, verb);
		assert.match(text, /--every/, verb);
		assert.match(text, /--command <cmd>/, verb);
		assert.doesNotMatch(text, /--setup <cmd>/, verb);
	}
	for (const command of ["new", "setup"]) assert.match(await help(command), /--setup <cmd>/, command);
	assert.doesNotMatch(await help("new"), /--command <cmd>/);
	assert.doesNotMatch(await help("rename"), /--setup <cmd>|--command <cmd>/);
	assert.doesNotMatch(await help("rename"), /--profile/);
	assert.match(await help("rename"), /--config <path>/);
	assert.match(await help("rename"), /--dir <path>/);
	assert.match(await help("list"), /--command <cmd>/);
	assert.match(await help("setup"), /<profile>\/--every {2,}every space of that profile, never base/);
	for (const command of Object.keys(HELP_USAGE)) assert.doesNotMatch(await help(command), /--profile <name>|"default"|\$PI_SPACES_(COMMAND|DIR|SETUP)/, command);
	const completion = await help("completion");
	assert.match(completion, /Supported shells: zsh, powershell\./);
	assert.match(completion, /zsh or powershell/);
	assert.match(completion, /pi-space completion powershell \| Out-String \| Invoke-Expression/);
	assert.doesNotMatch(completion, /--profile|--dir|--config|--command|--setup/);
});

test("--help <unknown> names the commands on stderr and exits 2", async () => {
	for (const argv of [["--help", "ghost"], ["-h", "ghost"]]) {
		const r = await run(argv, { files: { [CONFIG]: "{nope" } });
		assert.equal(r.code, 2, argv.join(" "));
		assert.equal(r.out, "");
		assert.equal(r.err, 'pi-space: No help for "ghost"; commands: list, new, setup, rename, remove, update, install, uninstall, completion.\n');
		assert.equal(r.spawned.length, 0);
	}
});

test("pi-space <space> --help still starts Pi with --help", async () => {
	const r = await run(["pi/work", "--help"], { spaces: ["work"] });
	assert.equal(r.code, 0);
	assert.equal(r.out, "");
	assert.deepEqual(r.spawned.map((spawn) => spawn.args), [["--space", "work", "--help"]]);
});

test("list with more than one word prints the usage to stderr and exits 2", async () => {
	const r = await run(["list", "pi/a", "extra"]);
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, USAGE);
});

test("an unknown space exits 1 and spawns nothing", async () => {
	const r = await run(["pi/ghost", "-c"], { spaces: ["work"] });
	assert.equal(r.code, 1);
	assert.equal(r.out, "");
	assert.equal(r.err, 'pi-space: Space "ghost" does not exist.\n');
	assert.equal(r.spawned.length, 0);
});

test("an invalid name exits 1 with the validation message and spawns nothing", async () => {
	const r = await run(["pi/Bad Name"]);
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
	const r = await run(["new", "pi/work"]);
	assert.equal(r.code, 0);
	assert.equal(r.out, `Created space "work" at ${join(r.dir, "work")}.\nStart Pi in it with: pi-space pi/work\n`);
	assert.equal(r.err, "");
	assert.deepEqual(r.settings, { work: { packages: ["npm:@jals1212/pi-spaces"] } });
	assert.equal(r.spawned.length, 0);
});

test("new copies the base home's declaration of the extension, as /space new does", async () => {
	const declaration = { source: "npm:@jals1212/pi-spaces@0.1.1", extensions: ["extensions/spaces.ts"] };
	const r = await run(["new", "pi/work"], { basePackages: ["npm:other", declaration], env: { PI_CODING_AGENT_DIR: "<root>/agent" } });
	assert.equal(r.code, 0);
	assert.deepEqual(r.settings.work, { packages: [declaration] });
	const fromSpace = await run(["new", "pi/work"], {
		basePackages: ["git:github.com/jals1212/pi-spaces"],
		env: { PI_CODING_AGENT_DIR: "<root>/spaces/other", PI_SPACES_BASE_HOME: "<root>/agent" },
	});
	assert.deepEqual(fromSpace.settings.work, { packages: ["git:github.com/jals1212/pi-spaces"] });
});

test("new copies a local path to another copy of the extension from the base home", async () => {
	const r = await run(["new", "pi/work"], {
		checkout: true,
		basePackages: [{ source: "../checkout", extensions: ["extensions/spaces.ts"] }],
		env: { PI_CODING_AGENT_DIR: "<root>/agent" },
	});
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.settings.work, { packages: [{ source: join(r.root, "checkout"), extensions: ["extensions/spaces.ts"] }] });
});

test("new copies the local path the base home loads the extension from, when it is the folder this command resolves", async () => {
	const packageRoot = dirname(fileURLToPath(import.meta.resolve("@jals1212/pi-spaces/package.json")));
	const r = await run(["new", "pi/work"], { basePackages: [packageRoot], env: { PI_CODING_AGENT_DIR: "<root>/agent" } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.settings.work, { packages: [packageRoot] });
});

test("new refuses a taken, reserved or invalid name with exit 1", async () => {
	const taken = await run(["new", "pi/work"], { spaces: ["work"] });
	assert.equal(taken.code, 1);
	assert.equal(taken.err, 'pi-space: Space "work" already exists.\n');
	assert.deepEqual(taken.settings, {});
	const reserved = await run(["new", "pi/base"]);
	assert.equal(reserved.code, 1);
	assert.match(reserved.err, /^pi-space: "base" is reserved/);
	const invalid = await run(["new", "pi/Bad Name"]);
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
	const r = await run(["remove", "pi/work", "--yes"], { spaces: ["work", "other"] });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.backups.length, 1);
	assert.match(r.backups[0], /^work-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
	assert.equal(r.out, `Removed space "work"; its backup is ${join(r.dir, ".backups", r.backups[0])}.\n`);
	assert.equal(r.err, "");
	assert.deepEqual(r.left, ["other"]);
	assert.equal(r.spawned.length, 0);
});

test("remove --yes reports a backup that cannot be written with exit 1 and keeps the space", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
	const r = await run(["remove", "pi/work", "--yes"], { spaces: ["work"], readOnly: true });
	assert.equal(r.code, 1);
	assert.match(r.err, /^pi-space: Could not back up space "work": .*EACCES.*\. The space was not removed; fix that, or remove it without a backup with --no-backup\.\n$/);
	assert.equal(r.out, "");
	assert.deepEqual(r.left, ["work"]);
	assert.deepEqual(r.backups, []);
});

test("remove --yes --no-backup deletes without a backup", async () => {
	const r = await run(["remove", "pi/work", "--yes", "--no-backup"], { spaces: ["work", "other"] });
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
		const r = await run(["remove", "pi/work"], { spaces: ["work"], tty: true, input });
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
		const r = await run(["remove", "pi/work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.backups.length, 1, JSON.stringify(input));
		assert.equal(
			r.out,
			`${removeQuestion(r.dir)}${backupQuestion(r.dir)}Removed space "work"; its backup is ${join(r.dir, ".backups", r.backups[0])}.\n`,
		);
		assert.deepEqual(r.left, []);
	}
	for (const input of ["y\nn\n", "y\nNO\n"]) {
		const r = await run(["remove", "pi/work"], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, 0, JSON.stringify(input));
		assert.equal(r.out, `${removeQuestion(r.dir)}${backupQuestion(r.dir)}Removed space "work".\n`);
		assert.deepEqual(r.left, []);
		assert.deepEqual(r.backups, []);
	}
});

test("remove --no-backup in a terminal asks only the first question", async () => {
	const r = await run(["remove", "pi/work", "--no-backup"], { spaces: ["work"], tty: true, input: "y\n" });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, `${removeQuestion(r.dir)}Removed space "work".\n`);
	assert.deepEqual(r.left, []);
	assert.deepEqual(r.backups, []);
});

test("remove without a terminal and without --yes refuses with exit 1 and keeps the space", async () => {
	const r = await run(["remove", "pi/work"], { spaces: ["work"], tty: false });
	assert.equal(r.code, 1);
	assert.equal(r.out, "");
	assert.equal(r.err, 'pi-space: Removing a space needs confirmation; run pi-space remove pi/work --yes.\n');
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
		const r = await run(["--dir", "<root>/spaces", "remove", `pi/${name}`], { ...options, tty: true, input: "y\n" });
		assert.equal(r.code, 1, name);
		assert.equal(r.out, "", name);
		if (typeof err === "string") assert.equal(r.err, err);
		else assert.match(r.err, err);
		assert.deepEqual(r.left, ["work"], name);
	}
});

test("remove protects the base home when run from inside a space", async () => {
	const r = await run(["--dir", "<root>/spaces", "remove", "pi/agent", "--yes"], {
		spaces: ["agent", "work"],
		env: { PI_CODING_AGENT_DIR: "<root>/spaces/work", PI_SPACES_BASE_HOME: "<root>/spaces/agent" },
	});
	assert.equal(r.code, 1);
	assert.equal(r.err, `pi-space: Space "agent" holds the base home ${join(r.dir, "agent")}; it cannot be removed.\n`);
	assert.deepEqual(r.left, ["agent", "work"]);
});

test("remove without exactly one name prints the usage to stderr and exits 2", async () => {
	const r = await run(["remove", "pi/a", "b"], { spaces: ["a", "b"] });
	assert.equal(r.code, 2);
	assert.equal(r.err, USAGE);
	assert.deepEqual(r.left, ["a", "b"]);
});

test("rename moves the space, keeps its settings and spawns nothing", async () => {
	const r = await run(["rename", "pi/work", "job"], { spaces: ["work", "other"] });
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
		const [from, ...to] = names;
		const r = await run(["--dir", "<root>/spaces", "rename", `pi/${from}`, ...to], options);
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
	assert.equal(created.err, "pi-space: --new was replaced by: pi-space new <profile>/<name>\n");
	assert.deepEqual(created.left, []);
	const removed = await run(["--remove", "work", "--yes"], { spaces: ["work"] });
	assert.equal(removed.code, 2);
	assert.equal(removed.out, "");
	assert.equal(removed.err, "pi-space: --remove was replaced by: pi-space remove <profile>/<name> [--yes] [--no-backup]\n");
	assert.deepEqual(removed.left, ["work"]);
	assert.equal(removed.spawned.length, 0);
});

test("list <space> runs Pi's list in that space through the extension, with inherited stdio and Pi's exit status", async () => {
	const r = await run(["--dir", "<root>/spaces", "list", "pi/work"], { spaces: ["work"], status: 4, env: { PI_CODING_AGENT_DIR: SOME_HOME } });
	assert.equal(r.code, 4);
	assert.equal(r.out, "");
	assert.equal(r.err, "");
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "pi", args: ["--space", "work", "list"] }]);
	assert.equal(r.spawned[0].options.stdio, "inherit");
	// The started Pi gets the caller's environment with the profile's variables; PI_CODING_AGENT_DIR is not touched.
	assert.deepEqual(setupEnvOf(r), { PI_CODING_AGENT_DIR: SOME_HOME, PI_SPACES_DIR: r.dir, PI_SPACES_COMMAND: "pi" });
});

test("update, install and uninstall run `--space <name> <command> <args>` through the profile's command and --command", async () => {
	const files = { [CONFIG]: { schema: SCHEMA, profiles: { ml: { command: "my-launcher --", dir: "~/spaces" } } } };
	const update = await run(["update", "ml/work", "--extensions"], { spaces: ["work"], files });
	assert.equal(update.code, 0, update.err);
	assert.deepEqual(update.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--", "--space", "work", "update", "--extensions"] }]);
	const install = await run(["--command", '"/opt/my launcher/run" --', "install", "pi/work", "npm:x@1", "-l"], { spaces: ["work"] });
	assert.equal(install.code, 0, install.err);
	assert.deepEqual(install.spawned.map(({ program, args }) => ({ program, args })), [
		{ program: "/opt/my launcher/run", args: ["--", "--space", "work", "install", "npm:x@1", "-l"] },
	]);
	const uninstall = await run(["uninstall", "pi/base", "npm:x"]);
	assert.deepEqual(uninstall.spawned.map(({ args }) => args), [["--space", "base", "uninstall", "npm:x"]]);
	const bare = await run(["update", "pi/work"], { spaces: ["work"] });
	assert.deepEqual(bare.spawned.map(({ args }) => args), [["--space", "work", "update"]]);
});

test("a package command returns the exit status of Pi", async () => {
	const r = await run(["install", "pi/work", "npm:x"], { spaces: ["work"], status: 9 });
	assert.equal(r.code, 9);
});

test("a package command never sets PI_CODING_AGENT_DIR, and --dir reaches the child as PI_SPACES_DIR", async () => {
	const env = { PI_SPACES_DIR: "<root>/elsewhere", PI_CODING_AGENT_DIR: SOME_HOME };
	const plain = await run(["--dir", "<root>/spaces", "update", "pi/work"], { spaces: ["work"], env: { PI_CODING_AGENT_DIR: SOME_HOME } });
	assert.deepEqual(setupEnvOf(plain), { PI_CODING_AGENT_DIR: SOME_HOME, PI_SPACES_DIR: plain.dir, PI_SPACES_COMMAND: "pi" });
	const withDir = await run(["--dir", "<root>/spaces", "update", "pi/work"], { spaces: ["work"], env });
	const childEnv = withDir.spawned[0].options.env as Record<string, string>;
	assert.equal(childEnv.PI_SPACES_DIR, withDir.dir);
	assert.equal(childEnv.PI_CODING_AGENT_DIR, SOME_HOME);
});

test("a package command in an unknown or invalid space exits 1 and spawns nothing", async () => {
	for (const verb of ["list", "update", "install", "uninstall"]) {
		const ghost = await run(verb === "list" || verb === "update" ? [verb, "pi/ghost"] : [verb, "pi/ghost", "npm:x"], { spaces: ["work"] });
		assert.equal(ghost.code, 1, verb);
		assert.equal(ghost.out, "", verb);
		assert.equal(ghost.err, 'pi-space: Space "ghost" does not exist.\n', verb);
		assert.equal(ghost.spawned.length, 0, verb);
	}
	const invalid = await run(["update", "pi/Bad Name"]);
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
	const files = { [CONFIG]: { schema: SCHEMA, profiles: { ml: { command: "run 'a b", dir: "~/spaces" } } } };
	const profile = await run(["update", "ml/work"], { spaces: ["work"], files });
	assert.equal(profile.code, 2);
	assert.equal(profile.err, `pi-space: profile "ml" command: the command has an unclosed ' quote.\n`);
	assert.equal(profile.spawned.length, 0);
	const option = await run(["--command", '"x', "update", "pi/work"], { spaces: ["work"] });
	assert.equal(option.code, 2);
	assert.equal(option.err, 'pi-space: --command: the command has an unclosed " quote.\n');
	const every = await run(["--command", '"x', "update", "pi/--every"], { spaces: ["work"] });
	assert.equal(every.code, 2);
	assert.equal(every.out, "");
	assert.equal(every.err, 'pi-space: --command: the command has an unclosed " quote.\n');
	assert.equal(every.spawned.length, 0);
	// --every alone checks every profile's command before running any.
	const all = await run(["update", "--every"], { spaces: ["work"], files });
	assert.equal(all.code, 2);
	assert.equal(all.out, "");
	assert.equal(all.err, `pi-space: profile "ml" command: the command has an unclosed ' quote.\n`);
	assert.equal(all.spawned.length, 0);
});

test("a package command whose program cannot start prints the reason and exits 1", async () => {
	const r = await run(["update", "pi/work"], { spaces: ["work"], spawnError: "spawn pi ENOENT" });
	assert.equal(r.code, 1);
	assert.equal(r.err, "pi-space: could not start pi: spawn pi ENOENT\n");
});

test("<profile>/--every runs base first, then every space in order, one at a time, each after its header", async () => {
	const r = await run(["update", "pi/--every", "--extensions"], { spaces: ["work", "alpha"], echo: true });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, "== pi/base\nran base\n== pi/alpha\nran alpha\n== pi/work\nran work\n");
	assert.equal(r.err, "");
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [
		{ program: "pi", args: ["--space", "base", "update", "--extensions"] },
		{ program: "pi", args: ["--space", "alpha", "update", "--extensions"] },
		{ program: "pi", args: ["--space", "work", "update", "--extensions"] },
	]);
	for (const spawned of r.spawned) assert.equal(spawned.options.stdio, "inherit");
});

test("<profile>/--every works for list, install and uninstall, and with no spaces it runs only base", async () => {
	const listed = await run(["list", "pi/--every"], { spaces: ["work"] });
	assert.deepEqual(listed.spawned.map(({ args }) => args), [["--space", "base", "list"], ["--space", "work", "list"]]);
	const installed = await run(["install", "pi/--every", "npm:x"], { spaces: ["work"] });
	assert.deepEqual(installed.spawned.map(({ args }) => args), [["--space", "base", "install", "npm:x"], ["--space", "work", "install", "npm:x"]]);
	const removed = await run(["uninstall", "pi/--every", "npm:x"]);
	assert.equal(removed.out, "== pi/base\n");
	assert.deepEqual(removed.spawned.map(({ args }) => args), [["--space", "base", "uninstall", "npm:x"]]);
});

test("--every goes on after a failure, exits 1 and names the failed spaces on the last line of stderr", async () => {
	const r = await run(["update", "pi/--every"], { spaces: ["a", "b", "c"], echo: true, statuses: { base: 3, b: 1 } });
	assert.equal(r.code, 1);
	assert.equal(r.out, "== pi/base\nran base\n== pi/a\nran a\n== pi/b\nran b\n== pi/c\nran c\n");
	assert.equal(r.err, "pi-space: update failed in: pi/base, pi/b\n");
	assert.equal(r.spawned.length, 4);
});

test("--every counts a program that cannot start as a failure and names the reason", async () => {
	const r = await run(["install", "pi/--every", "npm:x"], { spaces: ["a", "b"], spawnErrors: { a: "spawn pi ENOENT" } });
	assert.equal(r.code, 1);
	assert.equal(r.err, "pi-space: could not start pi: spawn pi ENOENT\npi-space: install failed in: pi/a\n");
	assert.equal(r.spawned.length, 3);
});

test("--every with --dir hands the folder to every child", async () => {
	const r = await run(["--dir", "<root>/spaces", "update", "pi/--every"], { spaces: ["a"], env: { PI_SPACES_DIR: "<root>/elsewhere" } });
	assert.equal(r.code, 0, r.err);
	for (const spawned of r.spawned) assert.equal((spawned.options.env as Record<string, string>).PI_SPACES_DIR, r.dir);
	assert.equal(r.spawned.length, 2);
});

test("--command runs that program for this call instead of the profile's command", async () => {
	const r = await run(["--command", "my-launcher --", "pi/work", "-c"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "other" } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--", "--space", "work", "-c"] }]);
	assert.equal(setupEnvOf(r).PI_SPACES_COMMAND, "my-launcher --");
});

test("--command with a quoted path launches that program with the path in one word", async () => {
	const r = await run(["--command", '"/opt/my launcher/run" --', "pi/work"], { spaces: ["work"] });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "/opt/my launcher/run", args: ["--", "--space", "work"] }]);
});

test("an unclosed quote in --command exits 2 naming --command and spawns nothing", async () => {
	const r = await run(["--command", '"/opt/my launcher/run --', "pi/work"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "other" } });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, 'pi-space: --command: the command has an unclosed " quote.\n');
	assert.equal(r.spawned.length, 0);
});

test("PI_SPACES_COMMAND is not read, even with an unclosed quote: the profile's command runs", async () => {
	const r = await run(["pi/work"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "run 'a b" } });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.err, "");
	assert.deepEqual(programsOf(r), [{ program: "pi", args: ["--space", "work"] }]);
});

test("the program and arguments reach spawn exactly as split, with no shell option, on every platform", async () => {
	const r = await run(["--command", '"C:\\Program Files\\x\\launcher.cmd" --', "pi/work", "-p", "hello world", "100%", "C:\\dir with space\\", "a&b"], { spaces: ["work"] });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [
		{ program: "C:\\Program Files\\x\\launcher.cmd", args: ["--", "--space", "work", "-p", "hello world", "100%", "C:\\dir with space\\", "a&b"] },
	]);
	assert.equal(r.spawned[0].options.stdio, "inherit");
	assert.equal("shell" in r.spawned[0].options, false);
});

test("--dir uses that spaces folder instead of the profile's, and the started Pi gets it as PI_SPACES_DIR", async () => {
	const env = { PI_SPACES_DIR: "<root>/elsewhere", PI_CODING_AGENT_DIR: SOME_HOME };
	const launched = await run(["--dir", "<root>/spaces", "pi/work"], { spaces: ["work"], env });
	assert.equal(launched.code, 0, launched.err);
	assert.deepEqual(launched.spawned[0].args, ["--space", "work"]);
	const childEnv = launched.spawned[0].options.env as Record<string, string>;
	assert.equal(childEnv.PI_SPACES_DIR, launched.dir);
	assert.equal(childEnv.PI_CODING_AGENT_DIR, SOME_HOME);

	const created = await run(["--dir", "<root>/spaces", "new", "pi/fresh"], { env });
	assert.equal(created.code, 0, created.err);
	assert.deepEqual(created.left, ["fresh"]);

	const removed = await run(["--dir", "<root>/spaces", "remove", "pi/work", "--yes"], { spaces: ["work"], env });
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
	const r = await run(["pi/base", "-p", "hi"], { status: 0 });
	assert.equal(r.code, 0);
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "pi", args: ["--space", "base", "-p", "hi"] }]);
});

test("an existing space launches the command with inherited stdio and the caller's env plus the profile's variables", async () => {
	const r = await run(["--command", "my-launcher --", "--dir", "<root>/spaces", "pi/work", "-c"], { spaces: ["work"], status: 7, env: { PI_SPACES_COMMAND: "other", PI_CODING_AGENT_DIR: SOME_HOME, OTHER: "kept" } });
	assert.equal(r.code, 7);
	assert.equal(r.spawned.length, 1);
	assert.equal(r.spawned[0].program, "my-launcher");
	assert.deepEqual(r.spawned[0].args, ["--", "--space", "work", "-c"]);
	assert.equal(r.spawned[0].options.stdio, "inherit");
	assert.deepEqual(setupEnvOf(r), { PI_CODING_AGENT_DIR: SOME_HOME, OTHER: "kept", PI_SPACES_DIR: r.dir, PI_SPACES_COMMAND: "my-launcher --" });
});

test("a command that cannot start prints the reason and exits 1", async () => {
	const r = await run(["pi/work"], { spaces: ["work"], spawnError: "spawn pi ENOENT" });
	assert.equal(r.code, 1);
	assert.equal(r.err, "pi-space: could not start pi: spawn pi ENOENT\n");
});

const DOWN = "\x1b[B";

test("picker: with only pi there are no groups: <profile>/base first, then the spaces; arrows and Enter launch the space under the cursor", async () => {
	const r = await run([], { spaces: ["alpha", "work"], tty: true, input: `${DOWN}${DOWN}\r`, status: 0 });
	assert.equal(r.code, 0);
	// The keys come in one chunk, so only the first frame is drawn.
	assert.match(r.out, /\n {2}> pi\/base\n {4}pi\/alpha\n {4}pi\/work/);
	assert.doesNotMatch(r.out, /\npi\n/);
	assert.deepEqual(r.spawned.map(({ args }) => args), [["--space", "work"]]);
});

test("picker: Enter at once launches base; typing filters first", async () => {
	assert.deepEqual((await run([], { spaces: ["work"], tty: true, input: "\r" })).spawned.map(({ args }) => args), [["--space", "base"]]);
	assert.deepEqual((await run([], { spaces: ["alpha", "work"], tty: true, input: "pi/wo\r" })).spawned.map(({ args }) => args), [["--space", "work"]]);
});

test("picker: Esc or the end of input exit 0 without launching; Ctrl-C exits 130", async () => {
	for (const [input, code] of [["\x1b", 0], ["", 0], ["\x03", 130]] as const) {
		const r = await run([], { spaces: ["work"], tty: true, input });
		assert.equal(r.code, code, JSON.stringify(input));
		assert.equal(r.spawned.length, 0);
		assert.equal(r.err, "");
	}
});

test("picker: the cursor starts on the active space, which is marked", async () => {
	const r = await run([], { spaces: ["alpha", "work"], tty: true, input: "\r", env: { PI_SPACE: "work", PI_SPACE_HOME: "<root>/spaces/work" } });
	assert.match(r.out, /> pi\/work \(active\)/);
	assert.deepEqual(r.spawned.map(({ args }) => args), [["--space", "work"]]);
});

test("picker: in base Pi the base of its profile is the active one", async () => {
	const r = await run([], { spaces: ["work"], tty: true, input: "\x1b", env: { PI_SPACE_HOME: "<root>/no-agent" } });
	assert.match(r.out, /> pi\/base \(active\)/);
});

const PICKER_FILES = {
	[CONFIG]: { schema: SCHEMA, profiles: { ml: { command: "my-launcher --", home: "~/ml/agent", dir: "~/spaces" }, other: { command: "other-launcher", dir: "~/other-spaces" } } },
	"other-spaces/zed/.keep": "",
};

test("picker: with a config file it groups every profile in file order, pi last, and lists a profile with the same folder too (here ml, twin and pi)", async () => {
	const r = await run([], { spaces: ["work"], tty: true, input: "\x1b", files: { ...PICKER_FILES, [CONFIG]: { ...PICKER_FILES[CONFIG], profiles: { ...PICKER_FILES[CONFIG].profiles, twin: { dir: "~/spaces" } } } } });
	assert.match(r.out, /\nml\n {2}> ml\/base\n {4}ml\/work\nother\n {4}other\/base\n {4}other\/zed\ntwin\n {4}twin\/base\n {4}twin\/work\npi\n {4}pi\/base\n {4}pi\/work/);
});

test("picker: a space of another profile starts with that profile's command and folder", async () => {
	const r = await run([], { spaces: ["work"], tty: true, input: "zed\r", files: PICKER_FILES });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.spawned.length, 1);
	assert.equal(r.spawned[0].program, "other-launcher");
	assert.deepEqual(r.spawned[0].args, ["--space", "zed"]);
	assert.equal((r.spawned[0].options.env as Record<string, string>).PI_SPACES_DIR, join(r.root, "other-spaces"));
	const own = await run([], { spaces: ["work"], tty: true, input: `${DOWN}\r`, files: PICKER_FILES });
	assert.equal(own.spawned[0].program, "my-launcher");
	assert.deepEqual(own.spawned[0].args, ["--", "--space", "work"]);
	// pi shares the folder of ml, and still runs its own command.
	const shared = await run([], { spaces: ["work"], tty: true, input: "pi/work\r", files: PICKER_FILES });
	assert.deepEqual(programsOf(shared), [{ program: "pi", args: ["--space", "work"] }]);
	assert.equal(setupEnvOf(shared).PI_SPACES_COMMAND, "pi");
});

test("picker: --setup of the call goes to a space of another profile, and does not hide the other profiles", async () => {
	const r = await run(["--setup", "my-setup {home}"], { spaces: ["work"], tty: true, input: "zed\r", files: PICKER_FILES });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.spawned.length, 1);
	assert.equal(r.spawned[0].program, "other-launcher");
	assert.equal((r.spawned[0].options.env as Record<string, string>).PI_SPACES_SETUP, "my-setup {home}");
	// The other profiles are still listed.
	assert.match(r.out, /\nml\n/);

	const own = await run(["--setup", "my-setup {home}"], { spaces: ["work"], tty: true, input: `${DOWN}\r`, files: PICKER_FILES });
	assert.equal((own.spawned[0].options.env as Record<string, string>).PI_SPACES_SETUP, "my-setup {home}");
});

test("picker: the command of another profile with an unclosed quote exits 2 naming its source, and nothing starts", async () => {
	const files = { ...PICKER_FILES, [CONFIG]: { ...PICKER_FILES[CONFIG], profiles: { ...PICKER_FILES[CONFIG].profiles, other: { command: "other 'x", dir: "~/other-spaces" } } } };
	const r = await run([], { spaces: ["work"], tty: true, input: "zed\r", files });
	assert.equal(r.code, 2);
	assert.match(r.err, /pi-space: .*profile.*other.*unclosed ' quote/);
	assert.equal(r.spawned.length, 0);
});

test("picker: the program of another profile that cannot start exits 1", async () => {
	const r = await run([], { spaces: ["work"], tty: true, input: "zed\r", files: PICKER_FILES, spawnErrors: { zed: "spawn other-launcher ENOENT" } });
	assert.equal(r.code, 1);
	assert.match(r.err, /could not start other-launcher/);
	assert.equal(r.spawned.length, 1);
});

test("picker: --setup and --config keep every profile in the list", async () => {
	for (const argv of [["--setup", "s {home}"], ["--config", "<root>/.pi-spaces/config.json"]]) {
		const r = await run(argv, { spaces: ["work"], tty: true, input: "\x1b", files: PICKER_FILES });
		assert.equal(r.code, 0, argv.join(" "));
		assert.match(r.out, /\nml\n.*\nother\n.*\npi\n/s, argv.join(" "));
	}
});

test("picker: the PI_SPACES_COMMAND of the caller is not read, so it cannot break the picker", async () => {
	const r = await run([], { spaces: ["work"], tty: true, input: "\r", env: { PI_SPACES_COMMAND: "run 'a b" } });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.err, "");
	assert.deepEqual(programsOf(r), [{ program: "pi", args: ["--space", "base"] }]);
});

test("picker: without a terminal the usage goes to stderr and the exit code is 2", async () => {
	const r = await run([], { spaces: ["work"], tty: false, input: "\r" });
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

test("bin/pi-space.mjs --dir and --command reach the real child: its PI_SPACES_DIR and PI_SPACES_COMMAND are those of the call, the rest of its env is untouched", () => {
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
		const result = spawnSync(process.execPath, [bin, "--command", `"${process.execPath}" "${script}"`, "--dir", dir, "pi/work", "-c"], {
			encoding: "utf8",
			env: { ...process.env, PI_SPACES_DIR: join(root, "elsewhere"), PI_SPACES_COMMAND: "not-run", PI_CODING_AGENT_DIR: SOME_HOME },
		});
		assert.equal(result.status, 3, result.stderr);
		const seen = JSON.parse(result.stdout);
		assert.deepEqual(seen.argv, ["--space", "work", "-c"]);
		assert.equal(seen.dir, dir);
		assert.equal(seen.home, SOME_HOME);
		// The child gets the command of this call, not the shell's value.
		assert.equal(seen.command, `"${process.execPath}" "${script}"`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bin/pi-space.mjs runs the profile's command with --space and exits with its code", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(join(dir, "work"), { recursive: true });
		const script = join(root, "fake.mjs");
		writeFileSync(
			script,
			'console.log(JSON.stringify({ argv: process.argv.slice(2), dir: process.env.PI_SPACES_DIR, home: process.env.PI_CODING_AGENT_DIR })); process.exit(7);\n',
		);
		const file = join(root, "config.json");
		writeFileSync(file, JSON.stringify({ schema: SCHEMA, profiles: { ml: { command: `"${process.execPath}" "${script}"`, dir } } }));
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const result = spawnSync(process.execPath, [bin, "--config", file, "ml/work", "-c"], {
			encoding: "utf8",
			env: { ...process.env, PI_SPACES_DIR: join(root, "elsewhere"), PI_SPACES_COMMAND: "not-run", PI_CODING_AGENT_DIR: SOME_HOME },
		});
		assert.equal(result.status, 7, result.stderr);
		const seen = JSON.parse(result.stdout);
		assert.deepEqual(seen.argv, ["--space", "work", "-c"]);
		assert.equal(seen.dir, dir);
		assert.ok(existsSync(join(seen.dir, "work")));
		assert.equal(seen.home, SOME_HOME);
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
		const result = spawnSync(process.execPath, [bin, "--command", `"${process.execPath}" "${script}"`, "--dir", dir, "pi/work"], { encoding: "utf8" });
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
		const result = spawnSync(process.execPath, [bin, "--command", `"${process.execPath}" "${script}"`, "--dir", dir, "pi/work", ...piArgs], { encoding: "utf8" });
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
		const result = spawnSync(process.execPath, [bin, "--command", "fake-pi", "--dir", dir, "pi/work", ...piArgs], {
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
		const result = spawnSync(process.execPath, [bin, "--command", "pi-space-no-such-program", "--dir", join(root, "spaces"), "pi/work"], { encoding: "utf8" });
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
	for (const argv of [["--setup"], ["--setup", ""], ["--setup", "  ", "new", "w"], ["--setup", "a", "--setup", "b"]]) assert.deepEqual(parseCli(argv), { kind: "usage" }, argv.join(" "));
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
	// A folder or name with "$" is put in as written, never read as a replacement pattern.
	assert.deepEqual(setupCommand("run {home} {name}", "/s/a$&b$'c$$", "x$1"), { program: "run", args: ["/s/a$&b$'c$$", "x$1"] });
});

function setupEnvOf(r: Run, index = 0): Record<string, string> {
	return r.spawned[index].options.env as Record<string, string>;
}

test("new runs the setup command in the new space after creating it, with the space as the agent home", async () => {
	const files = { [CONFIG]: { schema: SCHEMA, profiles: { ml: { dir: "~/spaces", setup: SETUP } } } };
	for (const [profile, argv, extra] of [
		["pi", ["--setup", SETUP, "--dir", "<root>/spaces", "new", "pi/work"], {}],
		["ml", ["new", "ml/work"], { files }],
	] as [string, string[], Record<string, unknown>][]) {
		const r = await run(argv, { ...extra, env: { PI_CODING_AGENT_DIR: SOME_HOME, OTHER: "kept" } });
		const home = join(r.dir, "work");
		assert.equal(r.code, 0, r.err);
		assert.equal(r.err, "");
		assert.equal(r.out, `Created space "work" at ${home}.\nSetting it up: my-launcher --home ${home} setup\nStart Pi in it with: pi-space ${profile}/work\n`);
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

test("new without a setup command runs nothing, whatever PI_SPACES_SETUP says", async () => {
	for (const env of [{}, { PI_SPACES_SETUP: SETUP }]) {
		const r = await run(["new", "pi/work"], { env });
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out, `Created space "work" at ${join(r.dir, "work")}.\nStart Pi in it with: pi-space pi/work\n`);
		assert.equal(r.spawned.length, 0);
	}
});

test("new keeps the space when its setup fails, exits with the setup's status and says how to run it again", async () => {
	const failed = await run(["--setup", SETUP, "new", "pi/work"], { status: 5 });
	assert.equal(failed.code, 5);
	assert.deepEqual(failed.left, ["work"]);
	assert.equal(failed.err, 'pi-space: Setup failed in space "work" (exit status 5); the space is kept. Run it again with: pi-space setup pi/work\n');
	const missing = await run(["--setup", SETUP, "new", "pi/work"], { spawnError: "spawn my-launcher ENOENT" });
	assert.equal(missing.code, 1);
	assert.deepEqual(missing.left, ["work"]);
	assert.equal(
		missing.err,
		'pi-space: could not start my-launcher: spawn my-launcher ENOENT\npi-space: Setup failed in space "work" (exit status 1); the space is kept. Run it again with: pi-space setup pi/work\n',
	);
});

test("new with an unclosed quote in the setup command exits 2 naming its source and creates nothing", async () => {
	const option = await run(["--setup", "run 'a", "new", "pi/work"]);
	assert.equal(option.code, 2);
	assert.equal(option.err, "pi-space: --setup: the command has an unclosed ' quote.\n");
	assert.deepEqual(option.left, []);
	const profile = await run(["new", "ml/work"], { files: { [CONFIG]: { schema: SCHEMA, profiles: { ml: { dir: "~/spaces", setup: '"x' } } } } });
	assert.equal(profile.code, 2);
	assert.equal(profile.err, 'pi-space: profile "ml" setup: the command has an unclosed " quote.\n');
	assert.deepEqual(profile.left, []);
	assert.equal(profile.spawned.length, 0);
});

test("setup <name> runs the setup command in that space and exits with its status", async () => {
	const r = await run(["--setup", SETUP, "setup", "pi/work"], { spaces: ["work"], status: 3 });
	const home = join(r.dir, "work");
	assert.equal(r.code, 3);
	assert.equal(r.out, "");
	assert.equal(r.err, "");
	assert.deepEqual(r.spawned.map(({ program, args }) => ({ program, args })), [{ program: "my-launcher", args: ["--home", home, "setup"] }]);
	assert.equal(setupEnvOf(r).PI_CODING_AGENT_DIR, home);
	assert.equal(setupEnvOf(r).PI_SPACE, "work");
});

test("setup refuses base, an unknown or invalid space with exit 1, and a missing setup command with exit 2, running nothing", async () => {
	const base = await run(["--setup", SETUP, "setup", "pi/base"]);
	assert.equal(base.code, 1);
	assert.equal(base.err, "pi-space: setup runs only in spaces, not in base (the home Pi starts with).\n");
	const ghost = await run(["--setup", SETUP, "setup", "pi/ghost"], { spaces: ["work"] });
	assert.equal(ghost.code, 1);
	assert.equal(ghost.err, 'pi-space: Space "ghost" does not exist.\n');
	const invalid = await run(["--setup", SETUP, "setup", "pi/Bad Name"]);
	assert.equal(invalid.code, 1);
	assert.match(invalid.err, /^pi-space: Invalid space name "Bad Name"/);
	// The caller's PI_SPACES_SETUP is not a setup command: the profile has none.
	for (const env of [{}, { PI_SPACES_SETUP: SETUP }]) {
		const none = await run(["setup", "pi/work"], { spaces: ["work"], env });
		assert.equal(none.code, 2);
		assert.equal(none.err, 'pi-space: Profile "pi" has no setup command; give it a "setup" in the config file, or give --setup <cmd>.\n');
		assert.equal(none.spawned.length, 0);
	}
	const quote = await run(["--setup", "x 'y", "setup", "--every"], { spaces: ["work"] });
	assert.equal(quote.code, 2);
	assert.equal(quote.out, "");
	assert.equal(quote.err, "pi-space: --setup: the command has an unclosed ' quote.\n");
	for (const r of [base, ghost, invalid, quote]) assert.equal(r.spawned.length, 0);
});

test("setup <profile>/--every runs in every space in order, never in base, goes on after a failure and exits 1 naming the failed ones", async () => {
	const r = await run(["--setup", SETUP, "setup", "pi/--every"], { spaces: ["work", "alpha", "beta"], echo: true, statuses: { beta: 2 } });
	assert.equal(r.code, 1);
	assert.equal(r.out, "== pi/alpha\nran alpha\n== pi/beta\nran beta\n== pi/work\nran work\n");
	assert.equal(r.err, "pi-space: setup failed in: pi/beta\n");
	assert.deepEqual(r.spawned.map(({ args }) => args[1]), ["alpha", "beta", "work"].map((name) => join(r.dir, name)));
	const ok = await run(["--setup", SETUP, "setup", "pi/--every"], { spaces: ["work"] });
	assert.equal(ok.code, 0, ok.err);
	const none = await run(["--setup", SETUP, "setup", "pi/--every"]);
	assert.equal(none.code, 0);
	assert.equal(none.out, "No spaces yet. Create one with pi-space new pi/<name>.\n");
	assert.equal(none.spawned.length, 0);
	const noSetup = await run(["setup", "pi/--every"], { spaces: ["work"] });
	assert.equal(noSetup.code, 2);
	assert.equal(noSetup.err, 'pi-space: Profile "pi" has no setup command; give it a "setup" in the config file, or give --setup <cmd>.\n');
});

test("--setup reaches the started Pi as PI_SPACES_SETUP, so /space new can name it; nothing else changes", async () => {
	const r = await run(["--setup", SETUP, "--dir", "<root>/spaces", "pi/work", "-c"], { spaces: ["work"], env: { PI_CODING_AGENT_DIR: SOME_HOME } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.spawned[0].args, ["--space", "work", "-c"]);
	assert.equal(setupEnvOf(r).PI_SPACES_SETUP, SETUP);
	assert.equal(setupEnvOf(r).PI_CODING_AGENT_DIR, SOME_HOME);
	const packages = await run(["--setup", SETUP, "update", "pi/work"], { spaces: ["work"] });
	assert.equal(setupEnvOf(packages).PI_SPACES_SETUP, SETUP);
});

const programsOf = (r: Run) => r.spawned.map(({ program, args }) => ({ program, args }));

test("parseCli: --config comes first with the other call options; a blank, missing or repeated one is usage; after a name they belong to Pi", () => {
	assert.deepEqual(parseCli(["--config", "/c.json", "--dir", "/d", "list"]), { kind: "list", config: "/c.json", dir: "/d" });
	assert.deepEqual(parseCli(["--config", "/c.json"]), { kind: "picker", config: "/c.json" });
	for (const argv of [["--config"], ["--config", " ", "list"], ["--config", "/a", "--config", "/b"]]) {
		assert.deepEqual(parseCli(argv), { kind: "usage" }, JSON.stringify(argv));
	}
	assert.deepEqual(parseCli(["pi/work", "--profile", "x", "--config", "y"]), { kind: "launch", name: "pi/work", args: ["--profile", "x", "--config", "y"] });
});

test("parseCli: completion takes one word, read before space names; __complete takes the words before the cursor", () => {
	assert.deepEqual(parseCli(["completion", "zsh"]), { kind: "completion", shell: "zsh" });
	assert.deepEqual(parseCli(["completion"]), { kind: "completion" });
	assert.deepEqual(parseCli(["completion", "zsh", "x"]), { kind: "usage" });
	assert.deepEqual(parseCli(["--config", "c.json", "__complete", "--dir", "x", "list"]), { kind: "complete", words: ["--dir", "x", "list"], config: "c.json" });
	assert.deepEqual(parseCli(["__complete"]), { kind: "complete", words: [] });
});

test("a config file that is not valid exits 2 with its message and starts nothing; help, version and completion do not read it", async () => {
	const files = { [CONFIG]: { schema: "pi-spaces.config/v9" } };
	const r = await run(["pi/work"], { spaces: ["work"], files });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, `pi-space: ${join(r.root, CONFIG)}: "schema" is "pi-spaces.config/v9", which needs a newer pi-spaces; this one reads "${SCHEMA}".\n`);
	assert.equal(r.spawned.length, 0);
	const given = await run(["--config", "<root>/bad.json", "list"], { files: { "bad.json": "{nope" } });
	assert.equal(given.code, 2);
	assert.match(given.err, /^pi-space: .*bad\.json: not valid JSON: .*\n$/);
	assert.equal(given.err.includes("    at "), false);
	for (const argv of [["--help"], ["--version"], ["completion", "zsh"]]) assert.equal((await run(argv, { files })).code, 0, argv.join(" "));
});

test("a missing config file is no config; an unknown profile exits 2 and lists the known ones", async () => {
	const none = await run(["--config", "<root>/missing.json", "pi/work"], { spaces: ["work"] });
	assert.equal(none.code, 0, none.err);
	assert.equal(none.spawned.length, 1);
	const ghost = await run(["ghost/work"], { spaces: ["work"] });
	assert.equal(ghost.code, 2);
	assert.equal(ghost.err, 'pi-space: Unknown profile "ghost"; known profiles: pi.\n');
	assert.equal(ghost.spawned.length, 0);
	const known = await run(["ghost/work"], { files: { [CONFIG]: { schema: SCHEMA, profiles: { ml: {} } } } });
	assert.equal(known.err, 'pi-space: Unknown profile "ghost"; known profiles: ml, pi.\n');
});

test("the command: --command, else the named profile's, else pi; PI_SPACES_COMMAND is never read", async () => {
	// Each profile names its dir, so the spaces are found; the built-in pi keeps its spaces next to PI_CODING_AGENT_DIR (<root>/spaces here).
	const files = {
		[CONFIG]: {
			schema: SCHEMA,
			profiles: { d: { command: "d-cmd --", dir: "~/spaces" }, ml: { command: "ml-cmd --", dir: "~/spaces" }, bare: { dir: "~/spaces" } },
		},
	};
	const cases: [string[], Record<string, string>, string][] = [
		[["d/work"], {}, "d-cmd"],
		[["ml/work"], { PI_SPACES_COMMAND: "env-cmd" }, "ml-cmd"],
		[["--command", "opt-cmd", "ml/work"], {}, "opt-cmd"],
		[["pi/work"], { PI_SPACES_COMMAND: "env-cmd" }, "pi"],
		// A profile without a command is pi's: no other profile lends its own, and the caller's variable does not count.
		[["bare/work"], {}, "pi"],
		[["bare/work"], { PI_SPACES_COMMAND: "env-cmd" }, "pi"],
	];
	for (const [argv, env, program] of cases) {
		const r = await run(argv, { spaces: ["work"], env, files });
		assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
		assert.deepEqual(programsOf(r).map((spawned) => spawned.program), [program], argv.join(" "));
		assert.deepEqual(r.spawned[0].args.slice(-2), ["--space", "work"], argv.join(" "));
	}
	// The started Pi is told the command of the profile, or none: the caller's leftover is removed.
	const none = await run(["bare/work"], { spaces: ["work"], env: { PI_SPACES_COMMAND: "env-cmd" }, files });
	assert.equal("PI_SPACES_COMMAND" in setupEnvOf(none), false);
	const quote = await run(["ml/work"], { spaces: ["work"], files: { [CONFIG]: { schema: SCHEMA, profiles: { ml: { command: "run 'a b", dir: "~/spaces" } } } } });
	assert.equal(quote.code, 2);
	assert.equal(quote.err, `pi-space: profile "ml" command: the command has an unclosed ' quote.\n`);
	assert.equal(quote.spawned.length, 0);
});

test("the spaces folder: --dir, else the named profile's; PI_SPACES_DIR is never read, and the started Pi gets the folder", async () => {
	const files = {
		[CONFIG]: { schema: SCHEMA, profiles: { d: { dir: "~/d-spaces" }, ml: { dir: "~/ml-spaces" } } },
		"d-spaces/work/.keep": "",
		"ml-spaces/work/.keep": "",
		"opt-spaces/work/.keep": "",
	};
	const cases: [string[], Record<string, string>, string][] = [
		[["d/work"], { PI_SPACES_DIR: "<root>/env-spaces" }, "d-spaces"],
		[["ml/work"], { PI_SPACES_DIR: "<root>/env-spaces" }, "ml-spaces"],
		[["--dir", "<root>/opt-spaces", "ml/work"], {}, "opt-spaces"],
		[["pi/work"], { PI_SPACES_DIR: "<root>/env-spaces" }, "spaces"],
	];
	for (const [argv, env, folder] of cases) {
		const r = await run(argv, { spaces: ["work"], env, files });
		assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
		assert.equal(setupEnvOf(r).PI_SPACES_DIR, join(r.root, folder), argv.join(" "));
	}
});

test("a profile's folder defaults to spaces next to its home", async () => {
	const r = await run(["list"], { files: { [CONFIG]: { schema: SCHEMA, profiles: { ml: { home: "~/ml/agent" } } } } });
	assert.equal(r.out.split("\n")[0], `Spaces of ml in ${join(r.root, "ml", "spaces")}:`);
});

test("the started Pi gets the profile's dir and setup as PI_SPACES_DIR and PI_SPACES_SETUP, and no setup when the profile has none", async () => {
	const files = {
		[CONFIG]: { schema: SCHEMA, profiles: { ml: { dir: "~/ml-spaces", setup: "ml-setup {home}" }, bare: { command: "bare --" } } },
		"ml-spaces/work/.keep": "",
	};
	const launched = await run(["ml/work"], { files });
	assert.equal(launched.code, 0, launched.err);
	assert.equal(setupEnvOf(launched).PI_SPACES_DIR, join(launched.root, "ml-spaces"));
	assert.equal(setupEnvOf(launched).PI_SPACES_SETUP, "ml-setup {home}");
	const packages = await run(["update", "ml/work"], { files });
	assert.equal(setupEnvOf(packages).PI_SPACES_DIR, join(packages.root, "ml-spaces"));
	assert.equal(setupEnvOf(packages).PI_SPACES_SETUP, "ml-setup {home}");
	// A profile without a setup: the caller's PI_SPACES_SETUP does not reach the started Pi.
	const bare = await run(["bare/work"], { spaces: ["work"], files, env: { PI_SPACES_SETUP: "leftover {home}" } });
	assert.equal(bare.code, 0, bare.err);
	assert.deepEqual(programsOf(bare), [{ program: "bare", args: ["--", "--space", "work"] }]);
	assert.equal(setupEnvOf(bare).PI_SPACES_DIR, bare.dir);
	assert.equal("PI_SPACES_SETUP" in setupEnvOf(bare), false);
});

test("--config is read for this call, reaches the started Pi as PI_SPACES_CONFIG (absolute), and a relative one is taken from the current folder", async () => {
	const files = {
		[CONFIG]: { schema: SCHEMA, profiles: { other: { command: "other --" } } },
		"alt.json": { schema: SCHEMA, profiles: { alt: { command: "alt --", dir: "~/spaces" } } },
	};
	const alt = await run(["--config", "<root>/alt.json", "alt/work"], { spaces: ["work"], files });
	assert.equal(alt.code, 0, alt.err);
	assert.deepEqual(programsOf(alt), [{ program: "alt", args: ["--", "--space", "work"] }]);
	assert.equal(setupEnvOf(alt).PI_SPACES_CONFIG, join(alt.root, "alt.json"));
	// The home config does not know it.
	assert.equal((await run(["alt/work"], { spaces: ["work"], files })).code, 2);
	const packages = await run(["--config", "<root>/alt.json", "update", "pi/work"], { spaces: ["work"], files });
	assert.equal(setupEnvOf(packages).PI_SPACES_CONFIG, join(packages.root, "alt.json"));
	const relative = await run(["--config", "no-such-config.json", "pi/work"], { spaces: ["work"] });
	assert.equal(setupEnvOf(relative).PI_SPACES_CONFIG, resolve("no-such-config.json"));
	// PI_SPACES_CONFIG from the environment picks the file too, and is already the child's own.
	const viaEnv = await run(["alt/work"], { spaces: ["work"], files, env: { PI_SPACES_CONFIG: "<root>/alt.json", PI_SPACES_DIR: "" } });
	assert.equal(viaEnv.code, 0, viaEnv.err);
	assert.equal(programsOf(viaEnv)[0].program, "alt");
});



const PROFILE_SETUP = {
	[CONFIG]: {
		schema: SCHEMA,
		profiles: {
			ml: { dir: "~/spaces", setup: "ml-setup --home {home} --space {name}", spaceEnv: { ML_CONFIG: "{home}/config", ML_NAME: "{name}" } },
			plain: { dir: "~/spaces" },
		},
	},
};

test("new runs the profile's setup with its spaceEnv in the setup's environment, on top of the space's own variables", async () => {
	const r = await run(["new", "ml/work"], { files: PROFILE_SETUP, env: { ML_CONFIG: "base-value", PI_CODING_AGENT_DIR: SOME_HOME } });
	const home = join(r.dir, "work");
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, `Created space "work" at ${home}.\nSetting it up: ml-setup --home ${home} --space work\nStart Pi in it with: pi-space ml/work\n`);
	assert.deepEqual(programsOf(r), [{ program: "ml-setup", args: ["--home", home, "--space", "work"] }]);
	const env = setupEnvOf(r);
	// The template's own "/" stays as written, on every platform.
	assert.equal(env.ML_CONFIG, `${home}/config`);
	assert.equal(env.ML_NAME, "work");
	assert.equal(env.PI_CODING_AGENT_DIR, home);
	assert.equal(env.PI_SPACE, "work");
	assert.equal(env.PI_SPACE_HOME, home);
});

test("setup <name> and setup --every run the profile's setup with its spaceEnv, each space with its own folder", async () => {
	const one = await run(["setup", "ml/work"], { spaces: ["work"], files: PROFILE_SETUP });
	assert.equal(one.code, 0, one.err);
	assert.equal(setupEnvOf(one).ML_CONFIG, `${join(one.dir, "work")}/config`);
	const every = await run(["setup", "ml/--every"], { spaces: ["a", "b"], files: PROFILE_SETUP });
	assert.deepEqual(every.spawned.map((_, index) => setupEnvOf(every, index).ML_NAME), ["a", "b"]);
	assert.deepEqual(every.spawned.map((_, index) => setupEnvOf(every, index).ML_CONFIG), [`${join(every.dir, "a")}/config`, `${join(every.dir, "b")}/config`]);
});

test("the setup: --setup, else the named profile's; PI_SPACES_SETUP is never read; the named profile's spaceEnv applies whichever it is", async () => {
	const option = await run(["--setup", "opt-setup {home}", "new", "ml/work"], { files: PROFILE_SETUP });
	assert.equal(programsOf(option)[0].program, "opt-setup");
	assert.equal(setupEnvOf(option).ML_NAME, "work");
	const viaEnv = await run(["new", "ml/work"], { files: PROFILE_SETUP, env: { PI_SPACES_SETUP: "env-setup {home}" } });
	assert.equal(programsOf(viaEnv)[0].program, "ml-setup");
	const envOnly = await run(["new", "plain/work"], { files: PROFILE_SETUP, env: { PI_SPACES_SETUP: "env-setup {home}" } });
	assert.equal(envOnly.code, 0, envOnly.err);
	assert.equal(envOnly.spawned.length, 0);
	assert.equal(envOnly.out, `Created space "work" at ${join(envOnly.dir, "work")}.\nStart Pi in it with: pi-space plain/work\n`);
	// Without a profile that has spaceEnv there is none.
	const none = await run(["--setup", "x {home}", "new", "pi/work"]);
	assert.equal(setupEnvOf(none).ML_NAME, undefined);
	const quote = await run(["new", "ml/work"], { files: { [CONFIG]: { schema: SCHEMA, profiles: { ml: { dir: "~/spaces", setup: "run 'a" } } } } });
	assert.equal(quote.code, 2);
	assert.equal(quote.err, `pi-space: profile "ml" setup: the command has an unclosed ' quote.\n`);
	assert.deepEqual(quote.left, []);
});

test("new declares the extension as the selected profile's home does, not as PI_CODING_AGENT_DIR does", async () => {
	const declaration = { source: "npm:@jals1212/pi-spaces@0.1.1", extensions: ["extensions/spaces.ts"] };
	const files = { [CONFIG]: { schema: SCHEMA, profiles: { ml: { home: "~/agent", dir: "~/spaces" } } } };
	const r = await run(["new", "ml/work"], { basePackages: [declaration], files });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.settings.work, { packages: [declaration] });
	const without = await run(["new", "pi/work"], { basePackages: [declaration] });
	assert.deepEqual(without.settings.work, { packages: ["npm:@jals1212/pi-spaces"] });
});

test("remove protects the selected profile's home as it protects the base home", async () => {
	const files = { [CONFIG]: { schema: SCHEMA, profiles: { ml: { home: "~/spaces/agent", dir: "~/spaces" } } } };
	const r = await run(["remove", "ml/agent", "--yes"], { spaces: ["agent", "work"], files });
	assert.equal(r.code, 1);
	assert.equal(r.err, `pi-space: Space "agent" holds the base home ${join(r.dir, "agent")}; it cannot be removed.\n`);
	assert.deepEqual(r.left, ["agent", "work"]);
});

const QUALIFIED = {
	[CONFIG]: { schema: SCHEMA, profiles: { gentle: { command: "gentle-cmd --", home: "~/gentle/agent", dir: "~/gentle-spaces" } } },
	"gentle-spaces/work/.keep": "",
};

const BARE = (name: string, profiles = "gentle, pi") => `pi-space: Name the space with its profile, as <profile>/${name} (profiles: ${profiles}).\n`;

test("<profile>/<name> starts Pi in that profile's space with its command, and hands it the profile's folder and command", async () => {
	const r = await run(["gentle/work", "-c"], { files: QUALIFIED });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.err, "");
	assert.deepEqual(programsOf(r), [{ program: "gentle-cmd", args: ["--", "--space", "work", "-c"] }]);
	assert.equal(setupEnvOf(r).PI_SPACES_DIR, join(r.root, "gentle-spaces"));
	assert.equal(setupEnvOf(r).PI_SPACES_COMMAND, "gentle-cmd --");
	const pi = await run(["pi/work"], { spaces: ["work"] });
	assert.equal(pi.code, 0, pi.err);
	assert.deepEqual(programsOf(pi), [{ program: "pi", args: ["--space", "work"] }]);
	assert.deepEqual(programsOf(await run(["gentle/base"], { files: QUALIFIED })), [{ program: "gentle-cmd", args: ["--", "--space", "base"] }]);
});

test("a name without its profile exits 2 and names the form; nothing starts, is created or removed", async () => {
	for (const argv of [["work"], ["base"], ["new", "work"], ["remove", "work", "--yes"], ["rename", "work", "fresh"], ["setup", "work"], ["update", "work"], ["list", "work"], ["install", "work", "npm:x"]]) {
		const r = await run(argv, { spaces: ["work"], files: QUALIFIED });
		assert.equal(r.code, 2, argv.join(" "));
		assert.equal(r.out, "", argv.join(" "));
		assert.equal(r.err, BARE(argv[0] === "work" || argv[0] === "base" ? argv[0] : argv[1]), argv.join(" "));
		assert.equal(r.spawned.length, 0, argv.join(" "));
		assert.deepEqual(r.left, ["work"], argv.join(" "));
		assert.deepEqual(r.backups, [], argv.join(" "));
	}
	assert.equal((await run(["work"], { spaces: ["work"] })).err, BARE("work", "pi"));
});

test("an unknown profile exits 2 and lists the known ones", async () => {
	const r = await run(["ghost/work"], { spaces: ["work"], files: QUALIFIED });
	assert.equal(r.code, 2);
	assert.equal(r.err, 'pi-space: Unknown profile "ghost"; known profiles: gentle, pi.\n');
	assert.equal(r.spawned.length, 0);
});

test("--profile was replaced by <profile>/<name>", async () => {
	const r = await run(["--profile", "gentle", "work"], { files: QUALIFIED });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, "pi-space: --profile was replaced by: pi-space <profile>/<name>\n");
	assert.equal(r.spawned.length, 0);
});

test("PI_SPACES_COMMAND, PI_SPACES_DIR and PI_SPACES_SETUP are not read: the named profile decides, and the started Pi gets its values", async () => {
	const env = { PI_SPACES_COMMAND: "env-cmd", PI_SPACES_DIR: "<root>/elsewhere", PI_SPACES_SETUP: "env-setup {home}" };
	const r = await run(["pi/work"], { spaces: ["work"], env });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(programsOf(r), [{ program: "pi", args: ["--space", "work"] }]);
	assert.equal(setupEnvOf(r).PI_SPACES_COMMAND, "pi");
	assert.equal(setupEnvOf(r).PI_SPACES_DIR, r.dir);
	assert.equal(setupEnvOf(r).PI_SPACES_SETUP, undefined);
	const created = await run(["new", "pi/fresh"], { env });
	assert.equal(created.code, 0, created.err);
	assert.deepEqual(created.left, ["fresh"]);
	assert.equal(created.spawned.length, 0);
});

test("a config's default is ignored with a warning on stderr; the file still applies", async () => {
	const files = { [CONFIG]: { ...QUALIFIED[CONFIG], default: "gentle" }, "gentle-spaces/work/.keep": "" };
	const r = await run(["pi/work"], { spaces: ["work"], files });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(programsOf(r), [{ program: "pi", args: ["--space", "work"] }]);
	assert.equal(r.err, `pi-space: ${join(r.root, CONFIG)}: "default" is no longer used; name each space with its profile (<profile>/<name>) and remove "default" from the file.\n`);
	assert.deepEqual(programsOf(await run(["gentle/work"], { files })), [{ program: "gentle-cmd", args: ["--", "--space", "work"] }]);
});

test("list alone lists every profile: its folder, then base and the spaces, each with its profile", async () => {
	const r = await run(["list"], { spaces: ["work"], files: QUALIFIED });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, `Spaces of gentle in ${join(r.root, "gentle-spaces")}:\n  gentle/base\n  gentle/work\nSpaces of pi in ${r.dir}:\n  pi/base\n  pi/work\n`);
	const none = await run(["list"]);
	assert.equal(none.out, `Spaces of pi in ${none.dir}:\n  pi/base\nNo spaces yet. Create one with pi-space new <profile>/<name>.\n`);
});

test("<profile>/--every runs in that profile's base and spaces; --every alone in every profile, each with its command", async () => {
	const one = await run(["update", "pi/--every"], { spaces: ["a"], files: QUALIFIED, echo: true });
	assert.equal(one.code, 0, one.err);
	assert.equal(one.out, "== pi/base\nran base\n== pi/a\nran a\n");
	assert.deepEqual(programsOf(one).map(({ program }) => program), ["pi", "pi"]);
	const all = await run(["update", "--every", "--extensions"], { spaces: ["a"], files: QUALIFIED, statuses: { work: 3 } });
	assert.equal(all.code, 1);
	assert.equal(all.out, "== gentle/base\n== gentle/work\n== pi/base\n== pi/a\n");
	assert.equal(all.err, "pi-space: update failed in: gentle/work\n");
	assert.deepEqual(programsOf(all), [
		{ program: "gentle-cmd", args: ["--", "--space", "base", "update", "--extensions"] },
		{ program: "gentle-cmd", args: ["--", "--space", "work", "update", "--extensions"] },
		{ program: "pi", args: ["--space", "base", "update", "--extensions"] },
		{ program: "pi", args: ["--space", "a", "update", "--extensions"] },
	]);
	assert.equal(setupEnvOf(all, 1).PI_SPACES_DIR, join(all.root, "gentle-spaces"));
	assert.equal(setupEnvOf(all, 3).PI_SPACES_DIR, all.dir);
});

test("setup --every alone runs in the spaces of every profile with a setup command; a profile without one is named", async () => {
	const files = { [CONFIG]: { schema: SCHEMA, profiles: { gentle: { ...QUALIFIED[CONFIG].profiles.gentle, setup: "gentle-setup {home}" } } }, "gentle-spaces/work/.keep": "" };
	const all = await run(["setup", "--every"], { spaces: ["a"], files });
	assert.equal(all.code, 0, all.err);
	assert.equal(all.out, "== gentle/work\n");
	assert.deepEqual(programsOf(all), [{ program: "gentle-setup", args: [join(all.root, "gentle-spaces", "work")] }]);
	const option = await run(["--setup", "s {name}", "setup", "--every"], { spaces: ["a"], files });
	assert.equal(option.out, "== gentle/work\n== pi/a\n");
	assert.deepEqual(programsOf(option), [{ program: "s", args: ["work"] }, { program: "s", args: ["a"] }]);
	const none = await run(["setup", "pi/a"], { spaces: ["a"], files });
	assert.equal(none.code, 2);
	assert.equal(none.err, 'pi-space: Profile "pi" has no setup command; give it a "setup" in the config file, or give --setup <cmd>.\n');
	assert.equal(none.spawned.length, 0);
	const nowhere = await run(["setup", "--every"], { spaces: ["a"] });
	assert.equal(nowhere.code, 2);
	assert.equal(nowhere.err, 'pi-space: No profile has a setup command; give one a "setup" in the config file, or give --setup <cmd>.\n');
});

test("--command and --dir apply to one profile: the picker, list alone and --every alone exit 2 with them", async () => {
	const message = "pi-space: --command and --dir apply to one profile; name it: <profile>/<name> or <profile>/--every.\n";
	for (const argv of [["--dir", "<root>/x", "list"], ["--command", "x", "update", "--every"], ["--dir", "<root>/x", "setup", "--every"], ["--command", "x"]]) {
		const r = await run(argv, { spaces: ["work"], tty: true, input: "\r", files: QUALIFIED });
		assert.equal(r.code, 2, argv.join(" "));
		assert.equal(r.out, "", argv.join(" "));
		assert.equal(r.err, message, argv.join(" "));
		assert.equal(r.spawned.length, 0, argv.join(" "));
	}
	const one = await run(["--command", "x --", "--dir", "<root>/gentle-spaces", "pi/work"], { files: QUALIFIED });
	assert.deepEqual(programsOf(one), [{ program: "x", args: ["--", "--space", "work"] }]);
});

test("rename keeps the profile: the new name alone or with the same profile; another profile exits 2", async () => {
	for (const to of ["fresh", "pi/fresh"]) {
		const r = await run(["rename", "pi/work", to], { spaces: ["work"] });
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out, 'Renamed space "work" to "fresh".\n');
		assert.deepEqual(r.left, ["fresh"]);
	}
	const other = await run(["rename", "pi/work", "gentle/fresh"], { spaces: ["work"], files: QUALIFIED });
	assert.equal(other.code, 2);
	assert.equal(other.err, "pi-space: A space keeps its profile: rename pi/work to pi/<name>.\n");
	assert.deepEqual(other.left, ["work"]);
});

test("the warning about default is printed once per call that uses the profiles, and never for help, version, completion or __complete", async () => {
	const files = { [CONFIG]: { ...QUALIFIED[CONFIG], default: "gentle" }, "gentle-spaces/work/.keep": "" };
	for (const argv of [["--help"], ["--version"], ["completion", "zsh"], ["__complete"], ["list", "--help"], ["--help", "list"]]) {
		const r = await run(argv, { files });
		assert.equal(r.code, 0, argv.join(" "));
		assert.equal(r.err, "", argv.join(" "));
	}
	const warning = (root: string) => `pi-space: ${join(root, CONFIG)}: "default" is no longer used; name each space with its profile (<profile>/<name>) and remove "default" from the file.\n`;
	const listed = await run(["list"], { files });
	assert.equal(listed.code, 0);
	assert.equal(listed.err, warning(listed.root));
	const bare = await run(["work"], { files });
	assert.equal(bare.code, 2);
	assert.equal(bare.err, `${warning(bare.root)}${BARE("work")}`);
	const none = await run(["gentle/work"], { files: QUALIFIED });
	assert.equal(none.err, "");
});

test("a name that starts with the slash has no profile either", async () => {
	const r = await run(["/work"], { spaces: ["work"] });
	assert.equal(r.code, 2);
	assert.equal(r.err, BARE("work", "pi"));
	assert.equal(r.spawned.length, 0);
});

test("setup --every checks the setup command of every profile before it runs any", async () => {
	const files = {
		[CONFIG]: { schema: SCHEMA, profiles: { ok: { dir: "~/ok-spaces", setup: "ok-setup {home}" }, bad: { dir: "~/bad-spaces", setup: "bad 'x" } } },
		"ok-spaces/a/.keep": "",
		"bad-spaces/b/.keep": "",
	};
	const r = await run(["setup", "--every"], { files });
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, `pi-space: profile "bad" setup: the command has an unclosed ' quote.\n`);
	assert.equal(r.spawned.length, 0);
});

test("picker: the space this Pi runs in is marked in its profile's group, and Enter starts it with that profile's command", async () => {
	const r = await run([], { tty: true, input: "\r", files: QUALIFIED, env: { PI_SPACE_HOME: "<root>/gentle-spaces/work" } });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /\ngentle\n.*> gentle\/work \(active\)/s);
	assert.deepEqual(programsOf(r), [{ program: "gentle-cmd", args: ["--", "--space", "work"] }]);
});

test("completion zsh prints a script that registers pi-space and asks __complete; another shell or none exits 2", async () => {
	const r = await run(["completion", "zsh"]);
	assert.equal(r.code, 0);
	assert.equal(r.err, "");
	assert.match(r.out, /compdef _pi_space pi-space/);
	assert.match(r.out, /__complete/);
	assert.match(r.out, /_files/);
	assert.equal(r.spawned.length, 0);
	const fish = await run(["completion", "fish"]);
	assert.equal(fish.code, 2);
	assert.equal(fish.out, "");
	assert.equal(fish.err, 'pi-space: Unsupported shell "fish"; supported shells: zsh, powershell.\n');
	const none = await run(["completion"]);
	assert.equal(none.code, 2);
	assert.equal(none.out, "");
	assert.equal(none.err, "pi-space: Name a shell: pi-space completion zsh (supported shells: zsh, powershell).\n");
	const extra = await run(["completion", "zsh", "x"]);
	assert.equal(extra.code, 2);
	assert.equal(extra.err, USAGE);
});

test("completion powershell prints a script that registers the pi-space completer and asks __complete", async () => {
	const r = await run(["completion", "powershell"]);
	assert.equal(r.code, 0);
	assert.equal(r.err, "");
	assert.match(r.out, /Register-ArgumentCompleter -Native -CommandName pi-space -ScriptBlock/);
	assert.match(r.out, /__complete/);
	assert.match(r.out, /__files__/);
	assert.match(r.out, /pi-space completion powershell \| Out-String \| Invoke-Expression/);
	assert.match(r.out, /Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete/);
	assert.doesNotMatch(r.out, /compdef/);
	assert.equal(r.spawned.length, 0);
	assert.notEqual(r.out, (await run(["completion", "zsh"])).out);
	const upper = await run(["completion", "PowerShell"]);
	assert.equal(upper.code, 2);
	assert.equal(upper.out, "");
	assert.equal(upper.err, 'pi-space: Unsupported shell "PowerShell"; supported shells: zsh, powershell.\n');
	const extra = await run(["completion", "powershell", "x"]);
	assert.equal(extra.code, 2);
	assert.equal(extra.err, USAGE);
});

test("the zsh completion script is valid zsh and completes through __complete", { skip: spawnSync("zsh", ["--version"]).error !== undefined && "zsh is not installed" }, async () => {
	const script = (await run(["completion", "zsh"])).out;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-zsh-")));
	try {
		writeFileSync(join(root, "script.zsh"), script);
		const result = spawnSync("zsh", ["-n", join(root, "script.zsh")], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/** The raw lines of `__complete`: `<group>\t<value>\t<description>`, or `__files__`. */
async function completeLines(words: string[], options: Parameters<typeof run>[1] = {}): Promise<string[]> {
	const r = await run(["__complete", ...words], options);
	assert.equal(r.code, 0, words.join(" "));
	assert.equal(r.err, "", words.join(" "));
	assert.equal(r.spawned.length, 0);
	return r.out === "" ? [] : r.out.replace(/\n$/, "").split("\n");
}

/** The candidates as `<group> <value>`, without the descriptions. */
async function complete(words: string[], options: Parameters<typeof run>[1] = {}): Promise<string[]> {
	return (await completeLines(words, options)).map((line) => line.split("\t").slice(0, 2).join(" "));
}

/** Two profiles: gentle (its own command and folder, one space) and the built-in pi (the folder of the run). */
const COMPLETE_FILES = {
	[CONFIG]: { schema: SCHEMA, profiles: { gentle: { command: "gentle-cmd --", dir: "~/gentle-spaces" } } },
	"gentle-spaces/work/.keep": "",
	"other-spaces/zed/.keep": "",
};

const FIRST_COMMANDS = ["command install", "command list", "command new", "command remove", "command rename", "command setup", "command uninstall", "command update"];

const COMMAND_LINES = [
	"command\tinstall\tinstall a package in a space",
	"command\tlist\tlist the spaces, or the packages of one",
	"command\tnew\tcreate a space",
	"command\tremove\tdelete a space, keeping a backup",
	"command\trename\trename a space",
	"command\tsetup\trun the setup command in a space",
	"command\tuninstall\tremove a package from a space",
	"command\tupdate\tupdate the packages of a space",
];

const OPTION_LINES = {
	"--command": "option\t--command\tthe program to run instead of the profile's command, e.g. \"my-launcher --\"; for one profile",
	"--dir": "option\t--dir\tthe spaces folder instead of the profile's; the Pi it starts gets it too; for one profile",
	"--setup": "option\t--setup\tthe setup command instead of the profile's; {home} and {name} become the space's folder and name",
	"--config": "option\t--config\tthe config file instead of $PI_SPACES_CONFIG (default: ~/.pi-spaces/config.json)",
	"--help": "option\t--help\tprint the help, or a command's: --help <command>",
	"--version": "option\t--version\tprint the version",
};

/** The spaces of the two profiles of COMPLETE_FILES with one pi space "a": pi's first, then gentle's, each alphabetical. */
const GSH_AND_PI_SPACES = [
	"space\tpi/a\tspace of pi (pi)",
	"space\tpi/base\tbase home of pi (pi)",
	"space\tgentle/base\tbase home of gentle (gentle-cmd --)",
	"space\tgentle/work\tspace of gentle (gentle-cmd --)",
];

test("__complete: the first word offers the spaces as <profile>/<name>, pi's first, then the custom profiles', each in alphabetical order, then the commands, then the options, one <group>\\t<value>\\t<description> per line", async () => {
	assert.deepEqual(await completeLines([], { spaces: ["a"], files: COMPLETE_FILES }), [
		...GSH_AND_PI_SPACES,
		...COMMAND_LINES,
		OPTION_LINES["--command"],
		OPTION_LINES["--dir"],
		OPTION_LINES["--setup"],
		OPTION_LINES["--config"],
		OPTION_LINES["--help"],
		OPTION_LINES["--version"],
	]);
});

test("__complete: with no config the first word offers only the built-in pi, with its spaces sorted", async () => {
	assert.deepEqual((await completeLines([], { spaces: ["work", "alpha"] })).filter((line) => line.startsWith("space\t")), [
		"space\tpi/alpha\tspace of pi (pi)",
		"space\tpi/base\tbase home of pi (pi)",
		"space\tpi/work\tspace of pi (pi)",
	]);
});

test("__complete: a profile without a command shows pi as its command; pi's spaces come first, then the custom profiles' in alphabetical order, whatever the file order", async () => {
	const files = { [CONFIG]: { schema: SCHEMA, profiles: { zeta: { dir: "~/zeta" }, alpha: { dir: "~/alpha" } } }, "zeta/s/.keep": "", "alpha/t/.keep": "" };
	assert.deepEqual((await completeLines([], { files })).filter((line) => line.startsWith("space\t")), [
		"space\tpi/base\tbase home of pi (pi)",
		"space\talpha/base\tbase home of alpha (pi)",
		"space\talpha/t\tspace of alpha (pi)",
		"space\tzeta/base\tbase home of zeta (pi)",
		"space\tzeta/s\tspace of zeta (pi)",
	]);
});

test("__complete: the first word leaves out the call options already typed, and --help and --version after one", async () => {
	const options = (lines: string[]) => lines.filter((line) => line.startsWith("option "));
	assert.deepEqual(options(await complete(["--command", "my-launcher --"])), ["option --dir", "option --setup", "option --config"]);
	assert.deepEqual(options(await complete(["--dir", "<root>/x", "--config", "<root>/c.json"])), ["option --command", "option --setup"]);
	assert.deepEqual(options(await complete(["--setup", "s {home}"])), ["option --command", "option --dir", "option --config"]);
});

test("__complete: completion is not offered as a command, but completion <TAB> still offers both shells", async () => {
	assert.ok(!(await complete([])).some((line) => line.includes("completion")));
	assert.deepEqual(await completeLines(["completion"]), ["shell\tzsh\tthe zsh completion script", "shell\tpowershell\tthe powershell completion script", "option\t--help\tthe help of this command"]);
});

test("__complete: after --help or -h it offers every command with its summary, completion too; nothing after one", async () => {
	const commands = ["command completion", ...FIRST_COMMANDS];
	assert.deepEqual(await complete(["--help"], { spaces: ["work"] }), commands);
	assert.deepEqual(await complete(["-h"]), commands);
	assert.deepEqual(await complete(["--command", "x", "--help"]), commands);
	assert.equal((await completeLines(["--help"]))[0], "command\tcompletion\tprint the shell completion script");
	assert.deepEqual(await complete(["--help", "list"]), []);
});

test("__complete: --profile is gone: it is never offered, and a word after it completes nothing", async () => {
	for (const words of [[], ["list"], ["setup"], ["remove"], ["--command", "x"]]) {
		const lines = await completeLines(words, { spaces: ["a"], files: COMPLETE_FILES });
		assert.ok(!lines.some((line) => line.includes("--profile") || line.startsWith("profile\t")), words.join(" "));
	}
	assert.deepEqual(await complete(["--profile"], { files: COMPLETE_FILES }), []);
	assert.deepEqual(await complete(["--profile", "gentle"], { files: COMPLETE_FILES }), []);
	assert.deepEqual(await complete(["--profile", "gentle", "list"], { files: COMPLETE_FILES }), []);
});

test("__complete: after --config or --dir it hands over to the file completion of the shell; after --command or --setup there is nothing", async () => {
	assert.deepEqual(await completeLines(["--config"]), ["__files__"]);
	assert.deepEqual(await completeLines(["--dir"]), ["__files__"]);
	assert.deepEqual(await completeLines(["--command", "x", "--dir"]), ["__files__"]);
	assert.deepEqual(await complete(["--command"]), []);
	assert.deepEqual(await complete(["--setup"]), []);
});

test("__complete: remove and rename offer the qualified spaces of every profile, never base; every command offers --help", async () => {
	const options = { spaces: ["a"], files: COMPLETE_FILES };
	assert.deepEqual(await completeLines(["remove"], options), [
		"space\tpi/a\tspace of pi (pi)",
		"space\tgentle/work\tspace of gentle (gentle-cmd --)",
		"option\t--yes\tdo not ask; keep a backup",
		"option\t--no-backup\tdelete without a backup",
		"option\t--help\tthe help of this command",
	]);
	assert.deepEqual(await completeLines(["rename"], options), ["space\tpi/a\tspace of pi (pi)", "space\tgentle/work\tspace of gentle (gentle-cmd --)", "option\t--help\tthe help of this command"]);
	assert.deepEqual(await complete(["new"], options), ["option --help"]);
});

test("__complete: setup offers the qualified spaces, then --every (every profile with a setup command) and <profile>/--every for each profile", async () => {
	assert.deepEqual(await completeLines(["setup"], { spaces: ["a"], files: COMPLETE_FILES }), [
		"space\tpi/a\tspace of pi (pi)",
		"space\tgentle/work\tspace of gentle (gentle-cmd --)",
		"target\t--every\tevery space of every profile with a setup command",
		"target\tgentle/--every\tevery space of gentle",
		"target\tpi/--every\tevery space of pi",
		"option\t--help\tthe help of this command",
	]);
});

test("__complete: list, update, install and uninstall offer base and spaces of every profile, then --every (every profile, base first) and <profile>/--every", async () => {
	for (const verb of ["list", "update", "install", "uninstall"]) {
		assert.deepEqual(await completeLines([verb], { spaces: ["a"], files: COMPLETE_FILES }), [
			...GSH_AND_PI_SPACES,
			"target\t--every\tevery profile, base first",
			"target\tgentle/--every\tbase and every space of gentle",
			"target\tpi/--every\tbase and every space of pi",
			"option\t--help\tthe help of this command",
		], verb);
	}
});

test("__complete: nothing after a name that is complete, nor a second word that is free text", async () => {
	const options = { spaces: ["work"], files: COMPLETE_FILES };
	for (const words of [["rename", "pi/work"], ["remove", "pi/work"], ["new", "x"], ["pi/work"], ["update", "pi/work"], ["update", "--every"], ["bogus"], ["setup", "gentle/--every"], ["completion", "zsh"]]) assert.deepEqual(await complete(words, options), [], words.join(" "));
});

test("__complete honors --config typed: it lists the profiles of that file", async () => {
	const files = { ...COMPLETE_FILES, "alt.json": { schema: SCHEMA, profiles: { alt: { command: "alt-cmd", dir: "~/other-spaces" } } } };
	assert.deepEqual((await completeLines(["--config", "<root>/alt.json"], { files })).filter((line) => line.startsWith("space\t")), [
		"space\tpi/base\tbase home of pi (pi)",
		"space\talt/base\tbase home of alt (alt-cmd)",
		"space\talt/zed\tspace of alt (alt-cmd)",
	]);
	assert.deepEqual(await complete(["--config", "<root>/alt.json", "setup"], { files }), ["space alt/zed", "target --every", "target alt/--every", "target pi/--every", "option --help"]);
});

test("__complete honors --dir typed: the spaces of that folder under every profile's prefix", async () => {
	const options = { spaces: ["a"], files: COMPLETE_FILES };
	assert.deepEqual(await completeLines(["--dir", "<root>/other-spaces", "remove"], options), [
		"space\tpi/zed\tspace of pi (pi)",
		"space\tgentle/zed\tspace of gentle (gentle-cmd --)",
		"option\t--yes\tdo not ask; keep a backup",
		"option\t--no-backup\tdelete without a backup",
		"option\t--help\tthe help of this command",
	]);
	assert.deepEqual(await complete(["--dir", "<root>/other-spaces", "list"], options), ["space pi/base", "space pi/zed", "space gentle/base", "space gentle/zed", "target --every", "target gentle/--every", "target pi/--every", "option --help"]);
	assert.deepEqual((await complete(["--dir", "<root>/other-spaces"], options)).filter((line) => line.startsWith("space ")), ["space pi/base", "space pi/zed", "space gentle/base", "space gentle/zed"]);
});

test("__complete: --command and --setup typed leave the candidates as they were", async () => {
	const options = { spaces: ["a"], files: COMPLETE_FILES };
	assert.deepEqual(await completeLines(["--command", "x --", "--setup", "s", "list"], options), await completeLines(["list"], options));
	assert.deepEqual(await completeLines(["--command", "x --", "setup"], options), await completeLines(["setup"], options));
});

test("__complete never fails loudly: a broken config prints nothing and exits 0; a missing folder has no spaces", async () => {
	assert.deepEqual(await complete([], { files: { [CONFIG]: "{nope" } }), []);
	assert.deepEqual(await complete(["list"], { files: { [CONFIG]: "{nope" } }), []);
	assert.deepEqual(await complete([], { files: { [CONFIG]: { schema: "pi-spaces.config/v9" } } }), []);
	assert.deepEqual(await complete(["--config", "<root>/bad.json", "list"], { files: { "bad.json": "{nope" } }), []);
	assert.deepEqual(await complete(["--dir", "<root>/missing", "list"]), ["space pi/base", "target --every", "target pi/--every", "option --help"]);
});

const ZSH_SKIP = spawnSync("zsh", ["--version"]).error !== undefined && "zsh is not installed";

/**
 * Runs the completion function under zsh with a fake pi-space that prints `lines`, and fake _describe and _files that
 * print what they were given: `_describe <tag> <array>: <elements>` and `_files`. Returns zsh's stdout, one line each.
 */
function zshComplete(script: string, lines: string[], prefix: string): string[] {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-zsh-")));
	try {
		writeFileSync(join(root, "script.zsh"), script);
		writeFileSync(join(root, "lines"), lines.join("\n") + (lines.length > 0 ? "\n" : ""));
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, "bin", "pi-space"), `#!/bin/sh\ncat '${join(root, "lines")}'\n`);
		chmodSync(join(root, "bin", "pi-space"), 0o755);
		const test = [
			"compdef() { :; }",
			'_files() { print -r -- "_files" }',
			'_describe() { local tag=$2 name=$4; print -r -- "_describe ${tag}:"; print -rl -- "${(@P)name}" }',
			`source '${join(root, "script.zsh")}'`,
			`PATH='${join(root, "bin")}':$PATH`,
			`words=(pi-space "${prefix}")`,
			"CURRENT=2",
			`PREFIX='${prefix}'`,
			"_pi_space",
			'print -r -- "status $?"',
		].join("\n");
		const result = spawnSync("zsh", ["-f", "-c", test], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.replace(/\n$/, "").split("\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("the zsh script splits the lines by group into commands, spaces, targets, shells and options for _describe, and escapes a colon; a value with a slash goes through as it is", { skip: ZSH_SKIP }, async () => {
	const script = (await run(["completion", "zsh"])).out;
	assert.doesNotMatch(script, /profile/);
	// pi-space gives the order (spaces first, alphabetical): zsh and fzf-tab must not sort it again.
	assert.match(script, /\nzstyle ':completion:\*:pi-space:\*' sort false\n/);
	// Each group under its own header, so the spaces stand apart from the commands and options (zsh and fzf-tab).
	assert.match(script, /\nzstyle ':completion:\*:pi-space:\*' group-name ''\n/);
	assert.match(script, /\nzstyle ':completion:\*:pi-space:\*:descriptions' format '\[%d\]'\n/);
	const lines = ["command\tlist\tlist the spaces", "command\tnew\tcreate a space", "space\tpi/base\tbase home of pi (pi)", "space\tpi/my:work\tspace of pi (pi)", "target\t--every\tevery profile, base first", "target\tpi/--every\tbase and every space of pi", "shell\tzsh\tthe zsh completion script", "option\t--yes\tdo not ask", "option\t--help\tthe help of this command"];
	assert.deepEqual(zshComplete(script, lines, "-"), [
		"_describe spaces:", "pi/base:base home of pi (pi)", "pi/my\\:work:space of pi (pi)",
		"_describe commands:", "list:list the spaces", "new:create a space",
		"_describe targets:", "--every:every profile, base first", "pi/--every:base and every space of pi",
		"_describe shells:", "zsh:the zsh completion script",
		"_describe options:", "--yes:do not ask", "--help:the help of this command",
		"status 0",
	]);
	// The options show only once the word starts with "-", so a lone --help is never inserted for an empty word.
	assert.deepEqual(zshComplete(script, lines, ""), [
		"_describe spaces:", "pi/base:base home of pi (pi)", "pi/my\\:work:space of pi (pi)",
		"_describe commands:", "list:list the spaces", "new:create a space",
		"_describe targets:", "--every:every profile, base first", "pi/--every:base and every space of pi",
		"_describe shells:", "zsh:the zsh completion script",
		"status 0",
	]);
});

test("the zsh script falls back to _files on the marker, and offers nothing for no candidates", { skip: ZSH_SKIP }, async () => {
	const script = (await run(["completion", "zsh"])).out;
	assert.deepEqual(zshComplete(script, ["__files__"], ""), ["_files", "status 0"]);
	assert.deepEqual(zshComplete(script, [], ""), ["status 1"]);
});

const PWSH_SKIP = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]).error !== undefined && "pwsh is not installed";

/** What one completion result shows: the text it inserts, the text in the list, and the tooltip. */
interface PwshMatch {
	text: string;
	list: string;
	tip: string;
}

/**
 * Runs the completion script under pwsh with a fake pi-space on PATH that prints `lines` (`{args}` in a line becomes
 * the words it was called with), then asks TabExpansion2 for each input with the cursor at its end, in a folder that
 * holds alpha.txt. Returns the matches of each input, in the order PowerShell gives them. A completion that throws gives
 * no matches, as in PSReadLine, which ignores the error: before PowerShell 7.7 that is what a lone "" from a completer
 * does (7.7 returns no matches for it).
 */
function pwshComplete(script: string, lines: string[], inputs: string[]): PwshMatch[][] {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-pwsh-")));
	try {
		writeFileSync(join(root, "script.ps1"), script);
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "cwd"));
		writeFileSync(join(root, "cwd", "alpha.txt"), "");
		const fake = join(root, "bin", "fake.mjs");
		writeFileSync(fake, `if (process.argv[2] !== "__complete") process.exit(3);\nfor (const line of ${JSON.stringify(lines)}) console.log(line.replaceAll("{args}", process.argv.slice(2).join(" ")));\n`);
		if (process.platform === "win32") {
			writeFileSync(join(root, "bin", "pi-space.cmd"), `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
		} else {
			writeFileSync(join(root, "bin", "pi-space"), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`);
			chmodSync(join(root, "bin", "pi-space"), 0o755);
		}
		const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
		const command = [
			"$ErrorActionPreference = 'Stop'",
			`$env:PATH = ${quote(join(root, "bin"))} + [System.IO.Path]::PathSeparator + $env:PATH`,
			`Set-Location -LiteralPath ${quote(join(root, "cwd"))}`,
			`Get-Content -Raw -LiteralPath ${quote(join(root, "script.ps1"))} | Invoke-Expression`,
			`foreach ($typed in @(${inputs.map(quote).join(", ")})) {`,
			"  $items = @()",
			"  try {",
			"    $result = TabExpansion2 -inputScript $typed -cursorColumn $typed.Length",
			"    $items = @($result.CompletionMatches | ForEach-Object { [pscustomobject]@{ text = $_.CompletionText; list = $_.ListItemText; tip = $_.ToolTip } })",
			"  } catch {}",
			"  Write-Output (ConvertTo-Json -InputObject $items -Compress)",
			"}",
		].join("\n");
		const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr + result.stdout);
		const outputs = result.stdout.trim().split(/\r?\n/);
		assert.equal(outputs.length, inputs.length, result.stdout);
		return outputs.map((output) => JSON.parse(output) as PwshMatch[]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("the powershell script lists the candidates in pi-space's order, shows options only for a dash, filters by prefix, and passes the words before the cursor", { skip: PWSH_SKIP }, async () => {
	const script = (await run(["completion", "powershell"])).out;
	const lines = [
		"space\tpi/base\tbase home of pi (pi)",
		"space\tpi/my work\tspace of pi (pi)",
		"command\tlist\tlist the spaces",
		"command\tnew\tcreate a space",
		"command\techo\targs {args}",
		"target\t--every\tevery profile, base first",
		"shell\tpowershell\tthe powershell completion script",
		"option\t--yes\t",
		"option\t--help\tthe help of this command",
	];
	const [all, dash, prefix, upper, slash, wildcard, words, word] = pwshComplete(script, lines, ["pi-space ", "pi-space -", "pi-space n", "pi-space PI/B", "pi-space pi/", "pi-space n*", "pi-space new pi/work ", "pi-space new e"]);
	const texts = (matches: PwshMatch[]) => matches.map((match) => match.text);
	// pi-space gives the order (spaces first): PowerShell must not sort it. A value with a space is quoted; the list shows it as it is.
	assert.deepEqual(texts(all), ["pi/base", "'pi/my work'", "list", "new", "echo", "--every", "powershell"]);
	assert.equal(all[1].list, "pi/my work");
	assert.deepEqual(all.slice(0, 3).map((match) => match.tip), ["base home of pi (pi)", "space of pi (pi)", "list the spaces"]);
	// The options show only once the word starts with "-"; a missing description shows the value.
	assert.deepEqual(texts(dash), ["--every", "--yes", "--help"]);
	assert.deepEqual(dash.map((match) => match.tip), ["every profile, base first", "--yes", "the help of this command"]);
	assert.deepEqual(texts(prefix), ["new"]);
	assert.deepEqual(texts(upper), ["pi/base"]);
	assert.deepEqual(texts(slash), ["pi/base", "'pi/my work'"]);
	// A wildcard is a plain character, never a pattern.
	assert.ok(!texts(wildcard).includes("new"), texts(wildcard).join(","));
	// The words before the cursor are passed to __complete; the word being completed is not.
	assert.equal(words.find((match) => match.text === "echo")?.tip, "args __complete new pi/work");
	assert.deepEqual(word.map((match) => [match.text, match.tip]), [["echo", "args __complete new"]]);
	assert.equal(all.find((match) => match.text === "echo")?.tip, "args __complete");
});

test("the powershell script falls back to PowerShell's own file completion on the marker only; no candidates offer no files", { skip: PWSH_SKIP }, async () => {
	const script = (await run(["completion", "powershell"])).out;
	const [files] = pwshComplete(script, ["__files__"], ["pi-space "]);
	assert.ok(files.some((match) => match.text.includes("alpha.txt")), JSON.stringify(files));
	assert.ok(!files.some((match) => match.text.includes("pi/")), JSON.stringify(files));
	// No candidates (after a complete name, say), none that match the word, or a pi-space that cannot run: nothing at all,
	// neither the files of the folder nor a space or the word typed again.
	const [none, unmatched] = pwshComplete(script, [], ["pi-space rename pi/work ", "pi-space al"]);
	assert.deepEqual(none, []);
	assert.deepEqual(unmatched, []);
	const [filtered] = pwshComplete(script, ["space\tpi/base\tbase home of pi (pi)"], ["pi-space al"]);
	assert.deepEqual(filtered, []);
	const [missing] = pwshComplete(script, ["space\tpi/base\tbase home of pi (pi)"], ["./missing/pi-space "]);
	assert.deepEqual(missing, []);
});

test("bin/pi-space.mjs <profile>/<name> starts the profile's command with the profile's dir, and completion zsh prints the script", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-bin-")));
	try {
		const dir = join(root, "spaces");
		mkdirSync(join(dir, "work"), { recursive: true });
		const script = join(root, "fake.mjs");
		writeFileSync(script, "console.log(JSON.stringify({ argv: process.argv.slice(2), dir: process.env.PI_SPACES_DIR, config: process.env.PI_SPACES_CONFIG })); process.exit(4);\n");
		const file = join(root, "config.json");
		writeFileSync(file, JSON.stringify({ schema: SCHEMA, profiles: { ml: { command: `"${process.execPath}" "${script}" --`, dir } } }));
		const bin = join(import.meta.dirname, "..", "bin", "pi-space.mjs");
		const result = spawnSync(process.execPath, [bin, "--config", file, "ml/work", "-c"], { encoding: "utf8", env: { ...process.env, PI_SPACES_DIR: join(root, "elsewhere") } });
		assert.equal(result.status, 4, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { argv: ["--", "--space", "work", "-c"], dir, config: file });
		const completion = spawnSync(process.execPath, [bin, "completion", "zsh"], { encoding: "utf8" });
		assert.equal(completion.status, 0, completion.stderr);
		assert.match(completion.stdout, /compdef _pi_space pi-space/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// The Pi that pi-space starts runs as if started from a plain terminal for the named profile, whatever Pi the caller is in.
const UNWIND = {
	[CONFIG]: {
		schema: SCHEMA,
		profiles: { gentle: { command: "gentle-cmd --", home: "~/gentle/agent", dir: "~/gentle/spaces", setup: "gentle-setup {home}", spaceEnv: { GSH_CFG: "{home}/cfg" } } },
	},
	"gentle/spaces/a/.keep": "",
	"gentle/spaces/b/.keep": "",
	".pi/spaces/work/.keep": "",
};
const IN_GSH_BASE = { PI_CODING_AGENT_DIR: "<root>/gentle/agent", PI_SPACE_HOME: "<root>/gentle/agent", PI_SPACES_COMMAND: "gentle-cmd --" };
const IN_GSH_SPACE = {
	PI_CODING_AGENT_DIR: "<root>/gentle/spaces/a",
	PI_SPACES_BASE_HOME: "<root>/gentle/agent",
	PI_SPACE: "a",
	PI_SPACE_HOME: "<root>/gentle/spaces/a",
	GSH_CFG: "<root>/gentle/spaces/a/cfg",
	PI_SPACES_BASE_ENV: JSON.stringify({ GSH_CFG: "<root>/shared/cfg" }),
	OTHER: "<root>/gentle/spaces/a/x",
};
const SPACE_VARIABLES = ["PI_SPACE", "PI_SPACE_HOME", "PI_SPACES_BASE_HOME", "PI_SPACES_BASE_ENV"];

test("from inside another profile's base Pi, pi/work and pi/base start Pi in the pi profile's home", async () => {
	for (const name of ["work", "base"]) {
		const r = await run([`pi/${name}`], { files: UNWIND, env: IN_GSH_BASE });
		assert.equal(r.code, 0, r.err);
		assert.deepEqual(programsOf(r), [{ program: "pi", args: ["--space", name] }]);
		const env = setupEnvOf(r);
		assert.equal(env.PI_CODING_AGENT_DIR, join(r.root, ".pi", "agent"));
		assert.equal(env.PI_SPACES_DIR, join(r.root, ".pi", "spaces"));
		assert.equal(env.PI_SPACES_COMMAND, "pi");
		for (const key of SPACE_VARIABLES) assert.equal(key in env, false, key);
	}
});

test("from inside a space, another space of the same profile gets the base's values, not the caller space's", async () => {
	const r = await run(["gentle/b"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(programsOf(r), [{ program: "gentle-cmd", args: ["--", "--space", "b"] }]);
	const env = setupEnvOf(r);
	assert.equal(env.PI_CODING_AGENT_DIR, join(r.root, "gentle", "agent"));
	assert.equal(env.GSH_CFG, join(r.root, "shared", "cfg"));
	assert.equal(env.OTHER, join(r.root, "gentle", "agent", "x"));
	assert.equal(env.PI_SPACES_DIR, join(r.root, "gentle", "spaces"));
	for (const key of SPACE_VARIABLES) assert.equal(key in env, false, key);
});

test("from inside a space, a space of another profile also gets the base's spaceEnv values back", async () => {
	const r = await run(["pi/work"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.equal(r.code, 0, r.err);
	const env = setupEnvOf(r);
	assert.equal(env.PI_CODING_AGENT_DIR, join(r.root, ".pi", "agent"));
	assert.equal(env.GSH_CFG, join(r.root, "shared", "cfg"));
	assert.equal(env.OTHER, join(r.root, "gentle", "agent", "x"));
	for (const key of SPACE_VARIABLES) assert.equal(key in env, false, key);
});

test("unwinding a space removes a spaceEnv variable the base did not have, moves each list entry on its own and keeps PWD", async () => {
	const list = ["<root>/gentle/spaces/a/bin", "/usr/bin", "<root>/gentle/spaces/ab", "<root>/gentle/spaces/a"].join(delimiter);
	const env = { ...IN_GSH_SPACE, PI_SPACES_BASE_ENV: "{}", LIST: list, PWD: "<root>/gentle/spaces/a/project" };
	const r = await run(["gentle/b", "-c"], { files: UNWIND, env });
	const child = setupEnvOf(r);
	assert.equal("GSH_CFG" in child, false);
	assert.equal(child.LIST, ["<root>/gentle/agent/bin", "/usr/bin", "<root>/gentle/spaces/ab", "<root>/gentle/agent"].map((entry) => normalize(entry.replace("<root>", r.root))).join(delimiter));
	assert.equal(child.PWD, join(r.root, "gentle", "spaces", "a", "project"));
	// A damaged PI_SPACES_BASE_ENV means no base values.
	const damaged = await run(["gentle/b"], { files: UNWIND, env: { ...IN_GSH_SPACE, PI_SPACES_BASE_ENV: "not json" } });
	assert.equal(damaged.code, 0, damaged.err);
	assert.equal("GSH_CFG" in setupEnvOf(damaged), false);
});

test("from a plain terminal the started Pi gets the named profile's home and nothing of a space", async () => {
	const r = await run(["gentle/b"], { files: UNWIND, env: { GSH_CFG: "<root>/shared/cfg", OTHER: "kept" } });
	assert.equal(r.code, 0, r.err);
	const env = setupEnvOf(r);
	assert.equal(env.PI_CODING_AGENT_DIR, join(r.root, "gentle", "agent"));
	assert.equal(env.GSH_CFG, join(r.root, "shared", "cfg"));
	assert.equal(env.OTHER, "kept");
	for (const key of SPACE_VARIABLES) assert.equal(key in env, false, key);
});

test("package commands and --every start each Pi in the named profile's home, unwound from the caller's space", async () => {
	const update = await run(["update", "gentle/b"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.equal(setupEnvOf(update).PI_CODING_AGENT_DIR, join(update.root, "gentle", "agent"));
	assert.equal(setupEnvOf(update).GSH_CFG, join(update.root, "shared", "cfg"));
	const every = await run(["update", "--every"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.deepEqual(every.spawned.map((_, index) => setupEnvOf(every, index).PI_CODING_AGENT_DIR), [
		...["agent", "agent", "agent"].map((folder) => join(every.root, "gentle", folder)),
		...[".pi", ".pi"].map((folder) => join(every.root, folder, "agent")),
	]);
	for (const index of every.spawned.keys()) {
		for (const key of SPACE_VARIABLES) assert.equal(key in setupEnvOf(every, index), false, key);
		assert.equal(setupEnvOf(every, index).GSH_CFG, join(every.root, "shared", "cfg"));
	}
});

test("the setup command runs with the new space's own values on top of the unwound base, not the caller space's", async () => {
	const r = await run(["new", "gentle/c"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.equal(r.code, 0, r.err);
	const home = join(r.root, "gentle", "spaces", "c");
	const env = setupEnvOf(r);
	assert.equal(env.PI_CODING_AGENT_DIR, home);
	assert.equal(env.PI_SPACE, "c");
	assert.equal(env.PI_SPACE_HOME, home);
	assert.equal(env.GSH_CFG, `${home}/cfg`);
	assert.equal(env.OTHER, join(r.root, "gentle", "agent", "x"));
	assert.equal("PI_SPACES_BASE_HOME" in env, false);
	assert.equal("PI_SPACES_BASE_ENV" in env, false);
	const again = await run(["setup", "gentle/b"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.equal(setupEnvOf(again).PI_SPACE, "b");
	assert.equal(setupEnvOf(again).GSH_CFG, `${join(again.root, "gentle", "spaces", "b")}/cfg`);
});

test("remove and rename still refuse the space the caller is in, from the caller's real environment", async () => {
	const removed = await run(["remove", "gentle/a", "--yes"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.equal(removed.code, 1);
	assert.match(removed.err, /is active/);
	assert.equal(removed.spawned.length, 0);
	const renamed = await run(["rename", "gentle/a", "z"], { files: UNWIND, env: IN_GSH_SPACE });
	assert.equal(renamed.code, 1);
	assert.match(renamed.err, /is active/);
});
