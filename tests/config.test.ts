import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	activeProfile,
	type Config,
	ConfigError,
	configPath,
	loadConfig,
	profileByName,
	profileForHome,
	profileNames,
	SCHEMA,
	spaceEnvFor,
} from "../src/config.ts";

// A path written with "/" and no drive is made absolute, so on Windows it gets the current drive.
const path = (...parts: string[]) => resolve(join(...parts));
const HOME = path("/home/u");

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
}

/** Loads a config from a JSON value (or raw text) through an injected reader. */
function load(content: unknown, file = "/c/config.json"): Config | undefined {
	return loadConfig(file, () => (typeof content === "string" ? content : JSON.stringify(content)));
}

/** The message loading this content fails with, naming the file. */
function failure(content: unknown, file = "/c/config.json"): string {
	try {
		load(content, file);
	} catch (error) {
		assert.ok(error instanceof ConfigError, "a ConfigError");
		assert.equal(error.name, "ConfigError");
		return error.message;
	}
	assert.fail(`no error for ${JSON.stringify(content)}`);
}

const v1 = (rest: Record<string, unknown> = {}) => ({ schema: "pi-spaces.config/v1", ...rest });
const v2 = (rest: Record<string, unknown> = {}) => ({ schema: SCHEMA, ...rest });
const NAME_RULE = 'use lowercase letters, digits, "-" and "_", starting with a letter or digit (at most 64 characters)';

test("configPath is PI_SPACES_CONFIG, else ~/.pi-spaces/config.json", () => {
	assert.equal(configPath({}, HOME), path(HOME, ".pi-spaces", "config.json"));
	assert.equal(configPath({ PI_SPACES_CONFIG: "" }, HOME), path(HOME, ".pi-spaces", "config.json"));
	assert.equal(configPath({ PI_SPACES_CONFIG: "   " }, HOME), path(HOME, ".pi-spaces", "config.json"));
	assert.equal(configPath({ PI_SPACES_CONFIG: "/etc/ps.json" }, HOME), path("/etc/ps.json"));
	assert.equal(configPath({ PI_SPACES_CONFIG: "~/cfg/ps.json" }, HOME), path(HOME, "cfg", "ps.json"));
	assert.equal(configPath({ PI_SPACES_CONFIG: "~" }, HOME), HOME);
	// A relative value resolves against the user's home, never the working directory.
	assert.equal(configPath({ PI_SPACES_CONFIG: "cfg/ps.json" }, HOME), path(HOME, "cfg", "ps.json"));
});

test("configPath is ~/.config/pi-spaces/config.json when that file exists and PI_SPACES_CONFIG is not set", () => {
	const xdg = path(HOME, ".config", "pi-spaces", "config.json");
	const legacy = path(HOME, ".pi-spaces", "config.json");
	const only = (...files: string[]) => (file: string) => files.includes(file);
	assert.equal(configPath({}, HOME, only(xdg)), xdg);
	// Both files: the XDG one wins.
	assert.equal(configPath({}, HOME, only(xdg, legacy)), xdg);
	// Only the old one, or none: the old path (a missing file stays "no config").
	assert.equal(configPath({}, HOME, only(legacy)), legacy);
	assert.equal(configPath({}, HOME, only()), legacy);
	// A blank XDG_CONFIG_HOME is unset.
	assert.equal(configPath({ XDG_CONFIG_HOME: "" }, HOME, only(xdg)), xdg);
	assert.equal(configPath({ XDG_CONFIG_HOME: "  " }, HOME, only(xdg)), xdg);
	// A relative XDG_CONFIG_HOME is ignored (XDG spec): ~/.config is used.
	assert.equal(configPath({ XDG_CONFIG_HOME: "rel/cfg" }, HOME, only(xdg)), xdg);
	assert.equal(configPath({ XDG_CONFIG_HOME: "rel/cfg" }, HOME, only(path("rel/cfg/pi-spaces/config.json"), path(HOME, "rel", "cfg", "pi-spaces", "config.json"))), legacy);
	// An absolute XDG_CONFIG_HOME replaces ~/.config.
	const custom = path("/etc/xdg-home", "pi-spaces", "config.json");
	assert.equal(configPath({ XDG_CONFIG_HOME: path("/etc/xdg-home") }, HOME, only(custom)), custom);
	assert.equal(configPath({ XDG_CONFIG_HOME: path("/etc/xdg-home") }, HOME, only(custom, xdg, legacy)), custom);
	// With XDG_CONFIG_HOME set, ~/.config is not looked at.
	assert.equal(configPath({ XDG_CONFIG_HOME: path("/etc/xdg-home") }, HOME, only(xdg)), legacy);
	// PI_SPACES_CONFIG wins over both.
	assert.equal(configPath({ PI_SPACES_CONFIG: "/etc/ps.json" }, HOME, only(xdg, legacy)), path("/etc/ps.json"));
});

test("configPath finds the XDG file on disk by default", () => {
	const root = scratch();
	assert.equal(configPath({}, root), join(root, ".pi-spaces", "config.json"));
	mkdirSync(join(root, ".config", "pi-spaces"), { recursive: true });
	writeFileSync(join(root, ".config", "pi-spaces", "config.json"), "{}");
	assert.equal(configPath({}, root), join(root, ".config", "pi-spaces", "config.json"));
});

test("loadConfig without a file is no config, and a file that cannot be read is an error naming it", () => {
	const root = scratch();
	assert.equal(loadConfig(join(root, "missing.json")), undefined);
	// A folder where the file should be is not "missing".
	assert.throws(() => loadConfig(root), (error: Error) => error instanceof ConfigError && error.message.startsWith(`${root}: cannot be read: `));
	const file = join(root, "config.json");
	writeFileSync(file, JSON.stringify(v1({ default: "pi" })));
	assert.deepEqual(loadConfig(file), { path: file, default: "pi", profiles: [] });
});

test("loadConfig reads a valid file into profiles in file order", () => {
	const config = load(
		v1({
			default: "launcher",
			profiles: {
				launcher: { home: "~/.launcher/agent", command: " my-launcher -- ", dir: "/s", setup: "my-launcher --home {home} setup", spaceEnv: { CFG: "{home}/cfg" } },
				"b-2": {},
				"9": { home: "/h" },
			},
		}),
	);
	assert.ok(config);
	assert.equal(config.path, "/c/config.json");
	assert.equal(config.default, "launcher");
	assert.deepEqual(config.profiles.map((profile) => profile.name).sort(), ["9", "b-2", "launcher"]);
	const launcher = config.profiles.find((profile) => profile.name === "launcher");
	assert.deepEqual(launcher, {
		name: "launcher",
		home: "~/.launcher/agent",
		command: "my-launcher --",
		dir: "/s",
		setup: "my-launcher --home {home} setup",
		spaceEnv: { CFG: "{home}/cfg" },
	});
	assert.deepEqual(load(v1())?.profiles, []);
	assert.equal(load(v1())?.default, undefined);
});

test("loadConfig refuses a file that is not JSON or not an object", () => {
	assert.match(failure("{ nope"), /^\/c\/config\.json: not valid JSON: /);
	assert.match(failure(""), /^\/c\/config\.json: not valid JSON: /);
	for (const content of [[], "null", 3, '"x"']) {
		assert.equal(failure(content), "/c/config.json: the top level must be a JSON object.");
	}
});

test("loadConfig requires schema pi-spaces.config/v1 or v2 and says when a newer pi-spaces is needed", () => {
	assert.equal(SCHEMA, "pi-spaces.config/v2");
	assert.equal(failure({}), '/c/config.json: "schema" is required; use "pi-spaces.config/v2".');
	assert.equal(failure({ profiles: {} }), '/c/config.json: "schema" is required; use "pi-spaces.config/v2".');
	for (const [schema, shown] of [
		["pi-spaces.config/v0", '"pi-spaces.config/v0"'],
		["pi-spaces.config/v01", '"pi-spaces.config/v01"'],
		["pi-spaces.config/vx", '"pi-spaces.config/vx"'],
		["pi-spaces.config", '"pi-spaces.config"'],
		["other/v1", '"other/v1"'],
		["", '""'],
		[1, "1"],
		[null, "null"],
	] as const) {
		assert.equal(failure({ schema }), `/c/config.json: invalid "schema" ${shown}; use "pi-spaces.config/v2".`, String(schema));
	}
	for (const n of ["3", "10"]) {
		assert.equal(
			failure({ schema: `pi-spaces.config/v${n}` }),
			`/c/config.json: "schema" is "pi-spaces.config/v${n}", which needs a newer pi-spaces; this one reads "pi-spaces.config/v1" and "pi-spaces.config/v2".`,
		);
	}
	// A newer file may have keys this version does not know: the version is the answer, not the key.
	assert.match(failure({ schema: "pi-spaces.config/v3", futureKey: 1 }), /needs a newer pi-spaces/);
	// Both versions this one reads load.
	assert.deepEqual(load(v1())?.profiles, []);
	assert.deepEqual(load(v2())?.profiles, []);
});

test("a v2 profile has commands: base, space and setup, resolved by profileByName", () => {
	const commands = { base: " my-launcher ", space: "my-launcher --home {home}", setup: "my-launcher --home {home} setup" };
	const config = load(v2({ profiles: { launcher: { home: "~/g", commands, spaceEnv: { A: "{home}" } } } }));
	assert.deepEqual(config?.profiles[0].commands, { base: "my-launcher", space: "my-launcher --home {home}", setup: "my-launcher --home {home} setup" });
	const profile = profileByName(config, "launcher", {}, HOME);
	assert.deepEqual(profile.commands, { base: "my-launcher", space: "my-launcher --home {home}" });
	// The command handed on is the space's; setup is the setup command.
	assert.equal(profile.command, "my-launcher --home {home}");
	assert.equal(profile.setup, "my-launcher --home {home} setup");
	// Without space, spaces start with <base> --space <name>: the command handed on is base.
	const plain = profileByName(load(v2({ profiles: { work: { commands: { base: "my-launcher --" } } } })), "work", {}, HOME);
	assert.deepEqual(plain.commands, { base: "my-launcher --" });
	assert.equal(plain.command, "my-launcher --");
	assert.equal(plain.setup, undefined);
	// A v2 profile without commands is like a v1 profile without command.
	const none = profileByName(load(v2({ profiles: { work: {} } })), "work", {}, HOME);
	assert.equal(none.commands, undefined);
	assert.equal(none.command, undefined);
	// v1 profiles have no commands.
	assert.equal(profileByName(load(v1({ profiles: { work: { command: "x" } } })), "work", {}, HOME).commands, undefined);
});

test("loadConfig checks v2 commands, and each schema refuses the other's profile keys", () => {
	const at = (commands: unknown) => failure(v2({ profiles: { launcher: { commands } } }));
	for (const value of ["my-launcher", null, [], 1]) {
		assert.equal(at(value), '/c/config.json: "commands" in profile "launcher" must be an object.', JSON.stringify(value));
	}
	assert.equal(at({}), '/c/config.json: "commands.base" in profile "launcher" is required.');
	assert.equal(at({ space: "x" }), '/c/config.json: "commands.base" in profile "launcher" is required.');
	for (const key of ["base", "space", "setup"]) {
		for (const value of ["", " ", 1, null]) {
			const commands = { base: "x", [key]: value };
			assert.equal(at(commands), `/c/config.json: "commands.${key}" in profile "launcher" must be a non-empty string.`, `${key} ${JSON.stringify(value)}`);
		}
	}
	assert.equal(at({ base: "x", start: "y" }), '/c/config.json: unknown key "start" in "commands" of profile "launcher"; allowed keys are "base", "space" and "setup".');
	for (const key of ["command", "setup", "homeless"]) {
		assert.equal(
			failure(v2({ profiles: { launcher: { [key]: "x" } } })),
			`/c/config.json: unknown key "${key}" in profile "launcher"; allowed keys are "home", "commands", "dir" and "spaceEnv".`,
		);
	}
	assert.equal(
		failure(v1({ profiles: { launcher: { commands: { base: "x" } } } })),
		'/c/config.json: unknown key "commands" in profile "launcher"; allowed keys are "home", "command", "dir", "setup", "spaceEnv" and "homeless".',
	);
});

test("loadConfig accepts // and /* */ comments outside strings", () => {
	const text = [
		"// pi-spaces config",
		"/* the built-in pi profile:",
		'   "pi": { "commands": { "base": "pi" } } */',
		"{",
		'  "schema": "pi-spaces.config/v2", // the version',
		'  "profiles": { "web": { "home": "/w//x", "commands": { "base": "open http://x/*y*/ --" } } }',
		"}",
		"// end",
	].join("\n");
	const config = load(text);
	assert.equal(config?.profiles[0].home, "/w//x");
	assert.deepEqual(config?.profiles[0].commands, { base: "open http://x/*y*/ --" });
	// A quote escaped inside a string does not end it.
	assert.equal(load('{"schema": "pi-spaces.config/v2", "profiles": {"a": {"home": "/q\\"//"}}}')?.profiles[0].home, '/q"//');
	assert.equal(failure('{"schema": "pi-spaces.config/v2"} /* open'), "/c/config.json: a /* comment is not closed.");
});

test("loadConfig refuses unknown keys at the top level and in a profile, naming the key", () => {
	assert.equal(failure(v1({ profile: {} })), '/c/config.json: unknown key "profile"; allowed keys are "schema", "default" and "profiles".');
	assert.equal(
		failure(v1({ profiles: { launcher: { hmoe: "/x" } } })),
		'/c/config.json: unknown key "hmoe" in profile "launcher"; allowed keys are "home", "command", "dir", "setup", "spaceEnv" and "homeless".',
	);
});

test("loadConfig checks profile names and shapes", () => {
	assert.equal(failure(v1({ profiles: [] })), '/c/config.json: "profiles" must be an object of profiles.');
	assert.equal(failure(v1({ profiles: "x" })), '/c/config.json: "profiles" must be an object of profiles.');
	for (const bad of ["Gsh", "-a", "_a", "a b", "a/b", "", "a".repeat(65)]) {
		assert.equal(failure(v1({ profiles: { [bad]: {} } })), `/c/config.json: invalid profile name "${bad}": ${NAME_RULE}.`, bad);
	}
	assert.equal(load(v1({ profiles: { [`a${"b".repeat(63)}`]: {} } }))?.profiles.length, 1);
	for (const value of [null, [], "x", 1]) {
		assert.equal(failure(v1({ profiles: { launcher: value } })), '/c/config.json: profile "launcher" must be an object.');
	}
});

test("loadConfig checks profile fields: home, command, dir and setup are non-empty strings", () => {
	for (const key of ["home", "command", "dir", "setup"]) {
		for (const value of ["", "   ", 1, null, true, [], {}]) {
			assert.equal(
				failure(v1({ profiles: { launcher: { [key]: value } } })),
				`/c/config.json: "${key}" in profile "launcher" must be a non-empty string.`,
				`${key}=${JSON.stringify(value)}`,
			);
		}
	}
});

test("loadConfig refuses spaceEnv variables that pi-spaces sets itself", () => {
	for (const reserved of ["PI_CODING_AGENT_DIR", "PI_SPACE", "PI_SPACE_HOME", "PI_SPACES_BASE_HOME", "PI_SPACES_BASE_ENV", "PI_SPACES_DIR", "PI_SPACES_SETUP"]) {
		assert.equal(
			failure(v1({ profiles: { launcher: { spaceEnv: { [reserved]: "v" } } } })),
			`/c/config.json: "${reserved}" in "spaceEnv" of profile "launcher" is set by pi-spaces itself; choose another variable.`,
			reserved,
		);
	}
	// Names that only look alike are the profile's own.
	assert.doesNotThrow(() => load(v1({ profiles: { launcher: { spaceEnv: { PI_SPACEX: "v", MY_PI_SPACE: "v" } } } }), "/c/config.json"));
});

test("loadConfig checks spaceEnv: an object of string values under variable-like names", () => {
	for (const value of ["x", [], null, 1]) {
		assert.equal(failure(v1({ profiles: { launcher: { spaceEnv: value } } })), '/c/config.json: "spaceEnv" in profile "launcher" must be an object of strings.');
	}
	for (const bad of ["1X", "A-B", "A B", "", "A=B", "é"]) {
		assert.equal(
			failure(v1({ profiles: { launcher: { spaceEnv: { [bad]: "v" } } } })),
			`/c/config.json: invalid variable name "${bad}" in "spaceEnv" of profile "launcher"; use letters, digits and "_", not starting with a digit.`,
			bad,
		);
	}
	for (const value of [1, null, true, [], {}]) {
		assert.equal(
			failure(v1({ profiles: { launcher: { spaceEnv: { CFG: value } } } })),
			'/c/config.json: "spaceEnv.CFG" in profile "launcher" must be a string.',
		);
	}
	const ok = load(v1({ profiles: { launcher: { spaceEnv: { _A1: "", b_2: "{home}", __proto__x: "1" } } } }));
	assert.deepEqual(ok?.profiles[0].spaceEnv, { _A1: "", b_2: "{home}", __proto__x: "1" });
});

test("loadConfig reads homeless: the words that run the command without its home, kept by profileByName", () => {
	const config = load(v1({ profiles: { launcher: { command: "my-launcher --home {home}", homeless: ["upgrade", "self-uninstall"] } } }));
	assert.deepEqual(config?.profiles[0].homeless, ["upgrade", "self-uninstall"]);
	assert.deepEqual(profileByName(config, "launcher", {}, HOME).homeless, ["upgrade", "self-uninstall"]);
	// A profile without it has none.
	assert.equal(profileByName(load(v1({ profiles: { launcher: {} } })), "launcher", {}, HOME).homeless, undefined);
});

test("loadConfig checks homeless: a non-empty list of words with no spaces", () => {
	for (const value of ["upgrade", [], null, 1, {}]) {
		assert.equal(
			failure(v1({ profiles: { launcher: { homeless: value } } })),
			'/c/config.json: "homeless" in profile "launcher" must be a non-empty list of words.',
			JSON.stringify(value),
		);
	}
	for (const [word, shown] of [["", '""'], ["self update", '"self update"'], [" x", '" x"'], [1, "1"], [null, "null"]] as const) {
		assert.equal(
			failure(v1({ profiles: { launcher: { homeless: ["upgrade", word] } } })),
			`/c/config.json: "homeless" in profile "launcher" has ${shown}, which is not one word; use words with no spaces.`,
			shown,
		);
	}
});

test("loadConfig checks default names a profile of the file or pi", () => {
	for (const value of [1, null, "", [], true]) {
		assert.equal(failure(v1({ default: value })), '/c/config.json: "default" must be a string naming a profile.');
	}
	assert.equal(failure(v1({ default: "launcher" })), '/c/config.json: "default" names unknown profile "launcher"; known profiles: pi.');
	assert.equal(
		failure(v1({ default: "x", profiles: { launcher: {}, alt: {} } })),
		'/c/config.json: "default" names unknown profile "x"; known profiles: launcher, alt, pi.',
	);
	assert.equal(load(v1({ default: "pi" }))?.default, "pi");
	assert.equal(load(v1({ default: "launcher", profiles: { launcher: {} } }))?.default, "launcher");
});

test("the built-in pi profile uses PI_CODING_AGENT_DIR or ~/.pi/agent, command pi, no setup, no spaceEnv", () => {
	const dflt = profileByName(undefined, "pi", {}, HOME);
	assert.deepEqual(dflt, { name: "pi", home: path(HOME, ".pi", "agent"), dir: path(HOME, ".pi", "spaces"), command: "pi" });
	assert.deepEqual(profileByName(load(v1()), "pi", { PI_CODING_AGENT_DIR: "~/.tool/agent" }, HOME), {
		name: "pi",
		home: path(HOME, ".tool", "agent"),
		dir: path(HOME, ".tool", "spaces"),
		command: "pi",
	});
	assert.equal(profileByName(undefined, "pi", { PI_CODING_AGENT_DIR: "/h/agent" }, HOME).home, path("/h/agent"));
	// Inside a space the base home is the one the space came from.
	assert.equal(
		profileByName(undefined, "pi", { PI_CODING_AGENT_DIR: "/h/spaces/work", PI_SPACES_BASE_HOME: "/h/agent" }, HOME).home,
		path("/h/agent"),
	);
});

test("inside the Pi of another profile, the built-in pi profile keeps ~/.pi/agent instead of that profile's home", () => {
	const config = load(v1({ profiles: { launcher: { home: "~/.launcher/agent" }, d: {} } }));
	const launcherHome = path(HOME, ".launcher", "agent");
	const piHome = path(HOME, ".pi", "agent");
	for (const env of [{ PI_CODING_AGENT_DIR: launcherHome }, { PI_CODING_AGENT_DIR: path(HOME, ".launcher", "spaces", "work"), PI_SPACES_BASE_HOME: launcherHome }]) {
		const pi = profileByName(config, "pi", env, HOME);
		assert.equal(pi.home, piHome, JSON.stringify(env));
		assert.equal(pi.dir, path(HOME, ".pi", "spaces"), JSON.stringify(env));
		// A profile without a home takes the built-in one's, so it stays in pi too.
		assert.equal(profileByName(config, "d", env, HOME).home, piHome, JSON.stringify(env));
		assert.equal(profileForHome(config, launcherHome, env, HOME)?.name, "launcher", JSON.stringify(env));
	}
	// A home that no profile of the file claims is still the pi home.
	assert.equal(profileByName(config, "pi", { PI_CODING_AGENT_DIR: "/h/agent" }, HOME).home, path("/h/agent"));
});

test("profiles.pi replaces the built-in one, keeping the home and command defaults for what it omits", () => {
	const config = load(v1({ profiles: { pi: { setup: "my-launcher setup", spaceEnv: { A: "{name}" } } } }));
	assert.deepEqual(profileByName(config, "pi", { PI_CODING_AGENT_DIR: "/h/agent" }, HOME), {
		name: "pi",
		home: path("/h/agent"),
		dir: path("/h", "spaces"),
		command: "pi",
		setup: "my-launcher setup",
		spaceEnv: { A: "{name}" },
	});
	const full = load(v1({ profiles: { pi: { home: "/x/agent", command: "pi --offline", dir: "/x/s" } } }));
	assert.deepEqual(profileByName(full, "pi", {}, HOME), { name: "pi", home: path("/x/agent"), dir: path("/x/s"), command: "pi --offline" });
	// Replaced, not merged: no setup or spaceEnv from anywhere else.
	assert.equal(profileByName(full, "pi", {}, HOME).setup, undefined);
	// The replacement is the only pi: it is not listed twice.
	assert.deepEqual(profileNames(full), ["pi"]);
});

test("profileByName resolves home and dir: tilde, relative to the user's home, and dir next to home by default", () => {
	const config = load(
		v1({
			profiles: {
				a: { home: "~/.a/agent", command: "my-launcher --", setup: "s {home}", spaceEnv: { K: "{home}/k" } },
				b: { home: "rel/agent", dir: "~/my/spaces" },
				c: { home: "/abs/agent", dir: "rel/spaces" },
				d: {},
			},
		}),
	);
	assert.deepEqual(profileByName(config, "a", {}, HOME), {
		name: "a",
		home: path(HOME, ".a", "agent"),
		dir: path(HOME, ".a", "spaces"),
		command: "my-launcher --",
		setup: "s {home}",
		spaceEnv: { K: "{home}/k" },
	});
	const b = profileByName(config, "b", {}, HOME);
	assert.equal(b.home, path(HOME, "rel", "agent"));
	assert.equal(b.dir, path(HOME, "my", "spaces"));
	assert.equal(b.command, undefined);
	assert.equal(profileByName(config, "c", {}, HOME).dir, path(HOME, "rel", "spaces"));
	// A profile without a home is not the built-in pi's: it has no command and the pi home.
	const d = profileByName(config, "d", { PI_CODING_AGENT_DIR: "/h/agent" }, HOME);
	assert.equal(d.home, path("/h/agent"));
	assert.equal(d.command, undefined);
});

test("profileByName refuses an unknown name, listing the known profiles with pi always among them", () => {
	assert.throws(() => profileByName(undefined, "launcher", {}, HOME), new ConfigError('Unknown profile "launcher"; known profiles: pi.'));
	const config = load(v1({ profiles: { launcher: {}, alt: {} } }));
	assert.throws(() => profileByName(config, "x", {}, HOME), new ConfigError('Unknown profile "x"; known profiles: launcher, alt, pi.'));
	assert.deepEqual(profileNames(config), ["launcher", "alt", "pi"]);
	assert.deepEqual(profileNames(undefined), ["pi"]);
	// Names that exist on every object are not profiles.
	assert.throws(() => profileByName(config, "constructor", {}, HOME), ConfigError);
});

test("profileForHome finds the profile whose home is the base home, in file order, then built-in pi", () => {
	const config = load(v1({ profiles: { first: { home: "/h/one" }, twin: { home: "/h/one/" }, launcher: { home: "~/.launcher/agent" } } }));
	assert.equal(profileForHome(config, path("/h/one"), {}, HOME)?.name, "first");
	assert.equal(profileForHome(config, path(HOME, ".launcher", "agent"), {}, HOME)?.name, "launcher");
	assert.equal(profileForHome(config, path(HOME, ".pi", "agent"), {}, HOME)?.name, "pi");
	assert.equal(profileForHome(config, path("/h/other"), {}, HOME), undefined);
	assert.equal(profileForHome(undefined, path(HOME, ".pi", "agent"), {}, HOME)?.name, "pi");
	assert.equal(profileForHome(undefined, path("/h/other"), {}, HOME), undefined);
	// A pi in the file is found where the file puts it, and the built-in one is gone.
	const replaced = load(v1({ profiles: { pi: { home: "/h/p" } } }));
	assert.equal(profileForHome(replaced, path("/h/p"), {}, HOME)?.name, "pi");
	assert.equal(profileForHome(replaced, path(HOME, ".pi", "agent"), {}, HOME), undefined);
});

test("profileForHome compares real paths, so a symlinked home still matches", { skip: process.platform === "win32" }, () => {
	const root = scratch();
	const real = join(root, "real", "agent");
	mkdirSync(real, { recursive: true });
	symlinkSync(join(root, "real"), join(root, "link"));
	const config = load(v1({ profiles: { launcher: { home: join(root, "link", "agent") } } }));
	assert.equal(profileForHome(config, real, {}, HOME)?.name, "launcher");
	// The profile keeps the path as written.
	assert.equal(profileForHome(config, real, {}, HOME)?.home, join(root, "link", "agent"));
	// A home that does not exist yet falls back to the resolved path.
	const absent = load(v1({ profiles: { launcher: { home: join(root, "nope", "agent") } } }));
	assert.equal(profileForHome(absent, join(root, "nope", "..", "nope", "agent"), {}, HOME)?.name, "launcher");
});

test("spaceEnvFor replaces every {home} and {name}, and leaves $ and other braces alone", () => {
	const profile = profileByName(
		load(v1({ profiles: { launcher: { spaceEnv: { CFG: "{home}/cfg", BOTH: "{name}:{home}:{name}", COST: "$&{name}$1$$", OTHER: "{x}{{name}}", EMPTY: "" } } } })),
		"launcher",
		{},
		HOME,
	);
	assert.deepEqual(spaceEnvFor(profile, "/s/work", "work"), {
		CFG: "/s/work/cfg",
		BOTH: "work:/s/work:work",
		COST: "$&work$1$$",
		OTHER: "{x}{work}",
		EMPTY: "",
	});
	// A home with $ patterns stays literal too.
	assert.equal(spaceEnvFor(profile, "/s/$&", "w").CFG, "/s/$&/cfg");
	assert.deepEqual(spaceEnvFor(profileByName(undefined, "pi", {}, HOME), "/s/work", "work"), {});
});

test("activeProfile loads the config at its path and picks the profile of the base home", () => {
	const root = scratch();
	const base = join(root, "launcher", "agent");
	const file = join(root, "config.json");
	writeFileSync(file, JSON.stringify(v1({ profiles: { launcher: { home: base, setup: "s", spaceEnv: { K: "{home}/k" } } } })));
	const env = { PI_SPACES_CONFIG: file };
	// Outside a space the agent home is the base home; inside one, PI_SPACES_BASE_HOME is.
	const outside = activeProfile(env, HOME, base);
	assert.equal(outside.warning, undefined);
	assert.equal(outside.profile?.name, "launcher");
	assert.equal(outside.profile?.dir, join(root, "launcher", "spaces"));
	const inside = activeProfile({ ...env, PI_SPACES_BASE_HOME: base }, HOME, join(root, "launcher", "spaces", "work"));
	assert.equal(inside.profile?.name, "launcher");
	// No profile for a home nobody described.
	assert.deepEqual(activeProfile(env, HOME, join(root, "other")), { profile: undefined, warning: undefined });
});

test("activeProfile without a file is today's behavior: the built-in pi, no warning", () => {
	const root = scratch();
	const env = { PI_SPACES_CONFIG: join(root, "none.json") };
	const result = activeProfile(env, root, join(root, ".pi", "agent"));
	assert.equal(result.warning, undefined);
	assert.equal(result.profile?.name, "pi");
	assert.deepEqual(activeProfile(env, root, join(root, "elsewhere")), { profile: undefined, warning: undefined });
});

test("activeProfile turns an invalid file into a warning naming it, and behaves as with no config", () => {
	const root = scratch();
	const file = join(root, "config.json");
	writeFileSync(file, JSON.stringify(v1({ profiles: { launcher: { hmoe: "/x" } } })));
	const result = activeProfile({ PI_SPACES_CONFIG: file }, root, join(root, ".pi", "agent"));
	assert.equal(result.warning, `${file}: unknown key "hmoe" in profile "launcher"; allowed keys are "home", "command", "dir", "setup", "spaceEnv" and "homeless".`);
	assert.equal(result.profile?.name, "pi");
});
