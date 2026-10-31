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

const v1 = (rest: Record<string, unknown> = {}) => ({ schema: SCHEMA, ...rest });
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
			default: "gsh",
			profiles: {
				gsh: { home: "~/.gsh/agent", command: " my-launcher -- ", dir: "/s", setup: "my-launcher --home {home} setup", spaceEnv: { CFG: "{home}/cfg" } },
				"b-2": {},
				"9": { home: "/h" },
			},
		}),
	);
	assert.ok(config);
	assert.equal(config.path, "/c/config.json");
	assert.equal(config.default, "gsh");
	assert.deepEqual(config.profiles.map((profile) => profile.name).sort(), ["9", "b-2", "gsh"]);
	const gsh = config.profiles.find((profile) => profile.name === "gsh");
	assert.deepEqual(gsh, {
		name: "gsh",
		home: "~/.gsh/agent",
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

test("loadConfig requires schema pi-spaces.config/v1 and says when a newer pi-spaces is needed", () => {
	assert.equal(SCHEMA, "pi-spaces.config/v1");
	assert.equal(failure({}), '/c/config.json: "schema" is required; use "pi-spaces.config/v1".');
	assert.equal(failure({ profiles: {} }), '/c/config.json: "schema" is required; use "pi-spaces.config/v1".');
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
		assert.equal(failure({ schema }), `/c/config.json: invalid "schema" ${shown}; use "pi-spaces.config/v1".`, String(schema));
	}
	for (const n of ["2", "3", "10"]) {
		assert.equal(
			failure({ schema: `pi-spaces.config/v${n}` }),
			`/c/config.json: "schema" is "pi-spaces.config/v${n}", which needs a newer pi-spaces; this one reads "pi-spaces.config/v1".`,
		);
	}
	// A newer file may have keys this version does not know: the version is the answer, not the key.
	assert.match(failure({ schema: "pi-spaces.config/v2", futureKey: 1 }), /needs a newer pi-spaces/);
});

test("loadConfig refuses unknown keys at the top level and in a profile, naming the key", () => {
	assert.equal(failure(v1({ profile: {} })), '/c/config.json: unknown key "profile"; allowed keys are "schema", "default" and "profiles".');
	assert.equal(
		failure(v1({ profiles: { gsh: { hmoe: "/x" } } })),
		'/c/config.json: unknown key "hmoe" in profile "gsh"; allowed keys are "home", "command", "dir", "setup" and "spaceEnv".',
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
		assert.equal(failure(v1({ profiles: { gsh: value } })), '/c/config.json: profile "gsh" must be an object.');
	}
});

test("loadConfig checks profile fields: home, command, dir and setup are non-empty strings", () => {
	for (const key of ["home", "command", "dir", "setup"]) {
		for (const value of ["", "   ", 1, null, true, [], {}]) {
			assert.equal(
				failure(v1({ profiles: { gsh: { [key]: value } } })),
				`/c/config.json: "${key}" in profile "gsh" must be a non-empty string.`,
				`${key}=${JSON.stringify(value)}`,
			);
		}
	}
});

test("loadConfig refuses spaceEnv variables that pi-spaces sets itself", () => {
	for (const reserved of ["PI_CODING_AGENT_DIR", "PI_SPACE", "PI_SPACE_HOME", "PI_SPACES_BASE_HOME", "PI_SPACES_BASE_ENV", "PI_SPACES_DIR", "PI_SPACES_SETUP"]) {
		assert.equal(
			failure(v1({ profiles: { gsh: { spaceEnv: { [reserved]: "v" } } } })),
			`/c/config.json: "${reserved}" in "spaceEnv" of profile "gsh" is set by pi-spaces itself; choose another variable.`,
			reserved,
		);
	}
	// Names that only look alike are the profile's own.
	assert.doesNotThrow(() => load(v1({ profiles: { gsh: { spaceEnv: { PI_SPACEX: "v", MY_PI_SPACE: "v" } } } }), "/c/config.json"));
});

test("loadConfig checks spaceEnv: an object of string values under variable-like names", () => {
	for (const value of ["x", [], null, 1]) {
		assert.equal(failure(v1({ profiles: { gsh: { spaceEnv: value } } })), '/c/config.json: "spaceEnv" in profile "gsh" must be an object of strings.');
	}
	for (const bad of ["1X", "A-B", "A B", "", "A=B", "é"]) {
		assert.equal(
			failure(v1({ profiles: { gsh: { spaceEnv: { [bad]: "v" } } } })),
			`/c/config.json: invalid variable name "${bad}" in "spaceEnv" of profile "gsh"; use letters, digits and "_", not starting with a digit.`,
			bad,
		);
	}
	for (const value of [1, null, true, [], {}]) {
		assert.equal(
			failure(v1({ profiles: { gsh: { spaceEnv: { CFG: value } } } })),
			'/c/config.json: "spaceEnv.CFG" in profile "gsh" must be a string.',
		);
	}
	const ok = load(v1({ profiles: { gsh: { spaceEnv: { _A1: "", b_2: "{home}", __proto__x: "1" } } } }));
	assert.deepEqual(ok?.profiles[0].spaceEnv, { _A1: "", b_2: "{home}", __proto__x: "1" });
});

test("loadConfig checks default names a profile of the file or pi", () => {
	for (const value of [1, null, "", [], true]) {
		assert.equal(failure(v1({ default: value })), '/c/config.json: "default" must be a string naming a profile.');
	}
	assert.equal(failure(v1({ default: "gsh" })), '/c/config.json: "default" names unknown profile "gsh"; known profiles: pi.');
	assert.equal(
		failure(v1({ default: "x", profiles: { gsh: {}, alt: {} } })),
		'/c/config.json: "default" names unknown profile "x"; known profiles: gsh, alt, pi.',
	);
	assert.equal(load(v1({ default: "pi" }))?.default, "pi");
	assert.equal(load(v1({ default: "gsh", profiles: { gsh: {} } }))?.default, "gsh");
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
	assert.throws(() => profileByName(undefined, "gsh", {}, HOME), new ConfigError('Unknown profile "gsh"; known profiles: pi.'));
	const config = load(v1({ profiles: { gsh: {}, alt: {} } }));
	assert.throws(() => profileByName(config, "x", {}, HOME), new ConfigError('Unknown profile "x"; known profiles: gsh, alt, pi.'));
	assert.deepEqual(profileNames(config), ["gsh", "alt", "pi"]);
	assert.deepEqual(profileNames(undefined), ["pi"]);
	// Names that exist on every object are not profiles.
	assert.throws(() => profileByName(config, "constructor", {}, HOME), ConfigError);
});

test("profileForHome finds the profile whose home is the base home, in file order, then built-in pi", () => {
	const config = load(v1({ profiles: { first: { home: "/h/one" }, twin: { home: "/h/one/" }, gsh: { home: "~/.gsh/agent" } } }));
	assert.equal(profileForHome(config, path("/h/one"), {}, HOME)?.name, "first");
	assert.equal(profileForHome(config, path(HOME, ".gsh", "agent"), {}, HOME)?.name, "gsh");
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
	const config = load(v1({ profiles: { gsh: { home: join(root, "link", "agent") } } }));
	assert.equal(profileForHome(config, real, {}, HOME)?.name, "gsh");
	// The profile keeps the path as written.
	assert.equal(profileForHome(config, real, {}, HOME)?.home, join(root, "link", "agent"));
	// A home that does not exist yet falls back to the resolved path.
	const absent = load(v1({ profiles: { gsh: { home: join(root, "nope", "agent") } } }));
	assert.equal(profileForHome(absent, join(root, "nope", "..", "nope", "agent"), {}, HOME)?.name, "gsh");
});

test("spaceEnvFor replaces every {home} and {name}, and leaves $ and other braces alone", () => {
	const profile = profileByName(
		load(v1({ profiles: { gsh: { spaceEnv: { CFG: "{home}/cfg", BOTH: "{name}:{home}:{name}", COST: "$&{name}$1$$", OTHER: "{x}{{name}}", EMPTY: "" } } } })),
		"gsh",
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
	const base = join(root, "gsh", "agent");
	const file = join(root, "config.json");
	writeFileSync(file, JSON.stringify(v1({ profiles: { gsh: { home: base, setup: "s", spaceEnv: { K: "{home}/k" } } } })));
	const env = { PI_SPACES_CONFIG: file };
	// Outside a space the agent home is the base home; inside one, PI_SPACES_BASE_HOME is.
	const outside = activeProfile(env, HOME, base);
	assert.equal(outside.warning, undefined);
	assert.equal(outside.profile?.name, "gsh");
	assert.equal(outside.profile?.dir, join(root, "gsh", "spaces"));
	const inside = activeProfile({ ...env, PI_SPACES_BASE_HOME: base }, HOME, join(root, "gsh", "spaces", "work"));
	assert.equal(inside.profile?.name, "gsh");
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
	writeFileSync(file, JSON.stringify(v1({ profiles: { gsh: { hmoe: "/x" } } })));
	const result = activeProfile({ PI_SPACES_CONFIG: file }, root, join(root, ".pi", "agent"));
	assert.equal(result.warning, `${file}: unknown key "hmoe" in profile "gsh"; allowed keys are "home", "command", "dir", "setup" and "spaceEnv".`);
	assert.equal(result.profile?.name, "pi");
});
