// Spaces: named Pi agent homes kept side by side in one folder.
// Host-agnostic: everything here relies only on Pi's PI_CODING_AGENT_DIR contract.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const BASE = "base";
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SpaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpaceError";
	}
}

export type Env = Record<string, string | undefined>;
export type PackageDeclaration = string | ({ source: string } & Record<string, unknown>);

function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** The folder that holds every space: PI_SPACES_DIR, else ~/.pi/spaces. */
export function spacesDir(env: Env = process.env, home: string = osHomedir()): string {
	const fromEnv = env.PI_SPACES_DIR;
	return fromEnv ? resolve(expandTilde(fromEnv, home)) : join(home, ".pi", "spaces");
}

/** Returns the error message for an unusable name, or undefined when the name is valid. */
export function validateName(name: string): string | undefined {
	if (name === BASE) return `"${BASE}" is reserved for the home Pi started with.`;
	if (!NAME.test(name)) {
		return `Invalid space name "${name}": use lowercase letters, digits, "-" and "_", starting with a letter or digit (at most 64 characters).`;
	}
	return undefined;
}

function assertName(name: string): void {
	const error = validateName(name);
	if (error) throw new SpaceError(error);
}

function isRealFolder(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Space names in the folder, sorted. Files, symlinks and invalid names are not spaces. */
export function listSpaces(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => validateName(name) === undefined && isRealFolder(join(dir, name)))
		.sort();
}

/** The space whose folder is the agent home, or undefined. */
export function activeSpace(dir: string, agentHome: string): string | undefined {
	for (const name of listSpaces(dir)) {
		if (samePath(join(dir, name), agentHome)) return name;
	}
	return undefined;
}

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isInside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Creates an empty space whose settings.json declares this package, so /space works inside it. */
export function createSpace(dir: string, name: string, declaration: PackageDeclaration): string {
	assertName(name);
	const path = join(dir, name);
	if (existsSync(path) || isSymlink(path)) throw new SpaceError(`Space "${name}" already exists.`);
	mkdirSync(dir, { recursive: true });
	mkdirSync(path);
	writeFileSync(join(path, "settings.json"), `${JSON.stringify({ packages: [declaration] }, null, 2)}\n`);
	return path;
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Throws the reason a space cannot be removed: base, invalid, missing, active, or not a real folder directly inside the spaces folder. */
export function checkRemovable(dir: string, name: string, agentHome: string): string {
	assertName(name);
	const path = join(dir, name);
	const realDir = realOrResolved(dir);
	if (isInside(realDir, realOrResolved(agentHome))) {
		throw new SpaceError(`The spaces folder ${dir} is the agent home or inside it; set PI_SPACES_DIR to a folder outside it.`);
	}
	if (!existsSync(path) && !isSymlink(path)) throw new SpaceError(`Space "${name}" does not exist.`);
	const notInside = new SpaceError(`Space "${name}" is not a folder inside ${dir}; remove it by hand.`);
	if (!isRealFolder(path)) throw notInside;
	if (dirname(realpathSync(path)) !== realDir) throw notInside;
	if (activeSpace(dir, agentHome) === name) {
		throw new SpaceError(`Space "${name}" is active; switch to another space before removing it.`);
	}
	return path;
}

/** Deletes a space after checkRemovable. */
export function removeSpace(dir: string, name: string, agentHome: string): void {
	rmSync(checkRemovable(dir, name, agentHome), { recursive: true, force: true });
}

function isLocalSource(source: string): boolean {
	return !/^(npm:|git:|https?:\/\/|ssh:\/\/|git@)/.test(source);
}

function npmName(source: string): string {
	const spec = source.slice("npm:".length);
	const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
	return at === -1 ? spec : spec.slice(0, at);
}

function gitRepoName(source: string): string {
	const withoutRef = source.replace(/@[^/@:]+$/, "");
	return withoutRef.replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
}

function samePath(a: string, b: string): boolean {
	return realOrResolved(a) === realOrResolved(b);
}

/**
 * This package's declaration in the current home's settings.json, so a new space loads it the same way.
 * A local path is made absolute. Without a match (for example when loaded with -e), the package folder itself.
 */
export function findOwnDeclaration(agentHome: string, packageName: string, packageRoot: string): PackageDeclaration {
	let packages: unknown;
	try {
		packages = JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8"))?.packages;
	} catch {
		return packageRoot;
	}
	if (!Array.isArray(packages)) return packageRoot;
	const repo = packageName.split("/").pop() ?? packageName;
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : undefined;
		if (source === undefined) continue;
		let match: string | undefined;
		if (source.startsWith("npm:")) {
			if (npmName(source) === packageName) match = source;
		} else if (isLocalSource(source)) {
			const absolute = isAbsolute(source) ? source : resolve(agentHome, expandTilde(source, osHomedir()));
			if (samePath(absolute, packageRoot)) match = absolute;
		} else if (gitRepoName(source) === repo) {
			match = source;
		}
		if (match !== undefined) return typeof entry === "string" ? match : { ...entry, source: match };
	}
	return packageRoot;
}
