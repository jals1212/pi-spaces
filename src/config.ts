// The config file: named profiles that describe a program that runs Pi (its agent home, the command
// that starts it, where its spaces live, how to set a space up, and the variables it needs per space).
// Pure and host-agnostic: the file system, the environment and the user's home are all inputs.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Env, expandTilde, samePath } from "./spaces.ts";

/** The schema this version of pi-spaces reads. */
export const SCHEMA = "pi-spaces.config/v1";
const NEWER_SCHEMA = /^pi-spaces\.config\/v([1-9][0-9]*)$/;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Set by pi-spaces itself on every switch; a profile that set them would break switching.
const RESERVED_VARIABLES = new Set(["PI_CODING_AGENT_DIR", "PI_SPACE", "PI_SPACE_HOME"]);
const isReservedVariable = (name: string) => RESERVED_VARIABLES.has(name) || name.startsWith("PI_SPACES_");
const TOP_KEYS = ["schema", "default", "profiles"];
const PROFILE_KEYS = ["home", "command", "dir", "setup", "spaceEnv"];
const BUILT_IN = "pi";

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** A profile as written in the file: validated and trimmed, paths not yet expanded. */
export interface ProfileSpec {
	name: string;
	home?: string;
	command?: string;
	dir?: string;
	setup?: string;
	spaceEnv?: Record<string, string>;
}

export interface Config {
	/** The file it was read from. */
	path: string;
	/** The profile used when none is asked for; a profile of the file or `pi`. */
	default?: string;
	/** In file order. */
	profiles: ProfileSpec[];
}

/** A profile with its paths resolved. `command`, `setup` and `spaceEnv` are set only when the profile has them. */
export interface Profile {
	name: string;
	/** The base agent home. */
	home: string;
	/** The spaces folder. */
	dir: string;
	command?: string;
	setup?: string;
	/** Variable templates; `{home}` and `{name}` are filled in by spaceEnvFor. */
	spaceEnv?: Record<string, string>;
}

/** The config file: PI_SPACES_CONFIG (a relative value is taken from the user's home), else ~/.pi-spaces/config.json. */
export function configPath(env: Env, home: string): string {
	const fromEnv = env.PI_SPACES_CONFIG?.trim();
	if (fromEnv) return resolve(home, expandTilde(fromEnv, home));
	return join(home, ".pi-spaces", "config.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type Fail = (problem: string) => never;

/**
 * Reads and validates the config file. A missing file is no config (undefined). Anything else wrong
 * throws a ConfigError that names the file and the problem; unknown keys are refused so typos fail loudly.
 */
export function loadConfig(path: string, read: (path: string) => string = (file) => readFileSync(file, "utf8")): Config | undefined {
	let text: string;
	try {
		text = read(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw new ConfigError(`${path}: cannot be read: ${reason(error)}`);
	}
	const fail: Fail = (problem) => {
		throw new ConfigError(`${path}: ${problem}`);
	};
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return fail(`not valid JSON: ${reason(error)}`);
	}
	if (!isObject(json)) return fail("the top level must be a JSON object.");
	// The version first: a newer file may use keys this one does not know.
	checkSchema(json.schema, "schema" in json, fail);
	for (const key of Object.keys(json)) {
		if (!TOP_KEYS.includes(key)) fail(`unknown key "${key}"; allowed keys are "schema", "default" and "profiles".`);
	}
	const config: Config = { path, profiles: parseProfiles(json.profiles, "profiles" in json, fail) };
	if ("default" in json) {
		const name = json.default;
		if (typeof name !== "string" || name === "") return fail('"default" must be a string naming a profile.');
		const known = profileNames(config);
		if (!known.includes(name)) fail(`"default" names unknown profile "${name}"; known profiles: ${known.join(", ")}.`);
		config.default = name;
	}
	return config;
}

function checkSchema(schema: unknown, present: boolean, fail: Fail): void {
	if (!present) fail(`"schema" is required; use "${SCHEMA}".`);
	if (schema === SCHEMA) return;
	const version = typeof schema === "string" ? NEWER_SCHEMA.exec(schema)?.[1] : undefined;
	// Only a canonical vN with N above 1 is a newer version; v0 and v01 are just invalid.
	if (version !== undefined && Number(version) > 1) {
		fail(`"schema" is "${schema}", which needs a newer pi-spaces; this one reads "${SCHEMA}".`);
	}
	fail(`invalid "schema" ${JSON.stringify(schema)}; use "${SCHEMA}".`);
}

function parseProfiles(value: unknown, present: boolean, fail: Fail): ProfileSpec[] {
	if (!present) return [];
	if (!isObject(value)) return fail('"profiles" must be an object of profiles.');
	return Object.entries(value).map(([name, profile]) => parseProfile(name, profile, fail));
}

function parseProfile(name: string, value: unknown, fail: Fail): ProfileSpec {
	if (!PROFILE_NAME.test(name)) {
		fail(`invalid profile name "${name}": use lowercase letters, digits, "-" and "_", starting with a letter or digit (at most 64 characters).`);
	}
	if (!isObject(value)) return fail(`profile "${name}" must be an object.`);
	for (const key of Object.keys(value)) {
		if (!PROFILE_KEYS.includes(key)) {
			fail(`unknown key "${key}" in profile "${name}"; allowed keys are "home", "command", "dir", "setup" and "spaceEnv".`);
		}
	}
	const spec: ProfileSpec = { name };
	for (const key of ["home", "command", "dir", "setup"] as const) {
		if (!(key in value)) continue;
		const text = value[key];
		if (typeof text !== "string" || text.trim() === "") return fail(`"${key}" in profile "${name}" must be a non-empty string.`);
		spec[key] = text.trim();
	}
	if ("spaceEnv" in value) spec.spaceEnv = parseSpaceEnv(name, value.spaceEnv, fail);
	return spec;
}

function parseSpaceEnv(profile: string, value: unknown, fail: Fail): Record<string, string> {
	if (!isObject(value)) return fail(`"spaceEnv" in profile "${profile}" must be an object of strings.`);
	const entries: [string, string][] = [];
	for (const [key, text] of Object.entries(value)) {
		if (!VARIABLE_NAME.test(key)) {
			fail(`invalid variable name "${key}" in "spaceEnv" of profile "${profile}"; use letters, digits and "_", not starting with a digit.`);
		}
		if (isReservedVariable(key)) fail(`"${key}" in "spaceEnv" of profile "${profile}" is set by pi-spaces itself; choose another variable.`);
		if (typeof text !== "string") return fail(`"spaceEnv.${key}" in profile "${profile}" must be a string.`);
		entries.push([key, text]);
	}
	// fromEntries defines own properties, so a name such as __proto__ stays plain data.
	return Object.fromEntries(entries);
}

/** The profile names, in file order, with `pi` last unless the file defines it. */
export function profileNames(config: Config | undefined): string[] {
	const names = (config?.profiles ?? []).map((profile) => profile.name);
	return names.includes(BUILT_IN) ? names : [...names, BUILT_IN];
}

/** The built-in pi home: the base home inside a space (PI_SPACES_BASE_HOME), else PI_CODING_AGENT_DIR, else ~/.pi/agent. */
function builtInHome(env: Env, home: string): string {
	const fromEnv = env.PI_SPACES_BASE_HOME || env.PI_CODING_AGENT_DIR;
	return fromEnv ? resolve(home, expandTilde(fromEnv, home)) : join(home, ".pi", "agent");
}

/** Resolves a profile; what a profile omits for `home` falls back to the built-in pi's, and `pi` also gets its `command`. */
function resolveProfile(spec: ProfileSpec, env: Env, home: string): Profile {
	const base = spec.home === undefined ? builtInHome(env, home) : resolve(home, expandTilde(spec.home, home));
	const profile: Profile = {
		name: spec.name,
		home: base,
		dir: spec.dir === undefined ? join(dirname(base), "spaces") : resolve(home, expandTilde(spec.dir, home)),
	};
	const command = spec.command ?? (spec.name === BUILT_IN ? "pi" : undefined);
	if (command !== undefined) profile.command = command;
	if (spec.setup !== undefined) profile.setup = spec.setup;
	if (spec.spaceEnv !== undefined) profile.spaceEnv = spec.spaceEnv;
	return profile;
}

/** The profile with this name, or a ConfigError that lists the known ones. `pi` always exists. */
export function profileByName(config: Config | undefined, name: string, env: Env, home: string): Profile {
	const spec = config?.profiles.find((profile) => profile.name === name) ?? (name === BUILT_IN ? { name } : undefined);
	if (spec === undefined) throw new ConfigError(`Unknown profile "${name}"; known profiles: ${profileNames(config).join(", ")}.`);
	return resolveProfile(spec, env, home);
}

/** The profile whose home is the base home (the same place, real paths compared): the first in file order, then built-in `pi`. */
export function profileForHome(config: Config | undefined, baseHome: string, env: Env, home: string): Profile | undefined {
	for (const name of profileNames(config)) {
		const profile = profileByName(config, name, env, home);
		if (samePath(profile.home, baseHome)) return profile;
	}
	return undefined;
}

/** The templates with every `{home}` and `{name}` replaced. Replacer functions keep `$` literal. */
export function expandSpaceEnv(templates: Record<string, string>, spaceHome: string, spaceName: string): Record<string, string> {
	const fill = (template: string) => template.replace(/\{home\}/g, () => spaceHome).replace(/\{name\}/g, () => spaceName);
	return Object.fromEntries(Object.entries(templates).map(([key, template]) => [key, fill(template)]));
}

/** The variables a space gets: the profile's spaceEnv for this space's folder and name (none without spaceEnv). */
export function spaceEnvFor(profile: Profile, spaceHome: string, spaceName: string): Record<string, string> {
	return expandSpaceEnv(profile.spaceEnv ?? {}, spaceHome, spaceName);
}

/**
 * The profile this Pi runs under, from the config file: the one whose home is the base home
 * (PI_SPACES_BASE_HOME, else the agent home). An unusable file never stops Pi: it comes back as
 * a warning and the result is the same as with no file.
 */
export function activeProfile(
	env: Env,
	home: string,
	agentHome: string,
	read?: (path: string) => string,
): { profile: Profile | undefined; warning: string | undefined } {
	const baseHome = env.PI_SPACES_BASE_HOME || agentHome;
	let config: Config | undefined;
	let warning: string | undefined;
	try {
		config = loadConfig(configPath(env, home), read);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		warning = error.message;
	}
	return { profile: profileForHome(config, baseHome, env, home), warning };
}
