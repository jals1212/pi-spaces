// Spaces: named Pi agent homes kept side by side in one folder.
// Host-agnostic: everything here relies only on Pi's PI_CODING_AGENT_DIR contract.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

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

/**
 * The folder that holds every space: PI_SPACES_DIR, else a `spaces` folder next to the base home
 * (~/.pi/agent gives ~/.pi/spaces), so every program that runs Pi with its own home keeps its own spaces.
 * The base home is the one Pi started with (PI_SPACES_BASE_HOME inside a space), else Pi's agent home.
 */
export function spacesDir(env: Env = process.env, home: string = osHomedir()): string {
	const fromEnv = env.PI_SPACES_DIR;
	// A relative value resolves against the user's home, never the working directory.
	if (fromEnv) return resolve(home, expandTilde(fromEnv, home));
	const agentHome = env.PI_CODING_AGENT_DIR ? expandTilde(env.PI_CODING_AGENT_DIR, home) : join(home, ".pi", "agent");
	const baseHome = env.PI_SPACES_BASE_HOME || agentHome;
	return join(dirname(resolve(baseHome)), "spaces");
}

// The words of the pi-space and /space commands, so a space name never reads as one.
const COMMANDS = new Set(["list", "new", "remove", "rename", "switch", "update", "install", "uninstall"]);

/** Returns the error message for an unusable name, or undefined when the name is valid. */
export function validateName(name: string): string | undefined {
	if (name === BASE) return `"${BASE}" is reserved for the home Pi started with.`;
	if (COMMANDS.has(name)) return `"${name}" is reserved: it is a pi-space or /space command.`;
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

const ACTIONS = {
	remove: { gerund: "removing", past: "removed" },
	rename: { gerund: "renaming", past: "renamed" },
};
type Action = keyof typeof ACTIONS;

/**
 * Throws the reason a space cannot be removed (or renamed, with action "rename"): base, invalid, missing, active, a spaces folder that is
 * not dedicated (the filesystem root, the user's home, the agent home or inside it), a space holding a
 * protected home, or anything that is not a real folder directly inside the spaces folder.
 */
export function checkRemovable(dir: string, name: string, agentHome: string, protect: string[] = [], userHome: string = osHomedir(), action: Action = "remove"): string {
	assertName(name);
	const { gerund, past } = ACTIONS[action];
	const path = join(dir, name);
	const realDir = realOrResolved(dir);
	if (parse(realDir).root === realDir || realDir === realOrResolved(userHome)) {
		throw new SpaceError(`The spaces folder ${dir} is not a dedicated folder; set PI_SPACES_DIR to one.`);
	}
	if (isInside(realDir, realOrResolved(agentHome))) {
		throw new SpaceError(`The spaces folder ${dir} is the agent home or inside it; set PI_SPACES_DIR to a folder outside it.`);
	}
	if (!existsSync(path) && !isSymlink(path)) throw new SpaceError(`Space "${name}" does not exist.`);
	const notInside = new SpaceError(`Space "${name}" is not a folder inside ${dir}; ${action} it by hand.`);
	if (!isRealFolder(path)) throw notInside;
	if (dirname(realpathSync(path)) !== realDir) throw notInside;
	if (activeSpace(dir, agentHome) === name) {
		throw new SpaceError(`Space "${name}" is active; switch to another space before ${gerund} it.`);
	}
	const realPath = realpathSync(path);
	for (const home of [agentHome, ...protect]) {
		if (isInside(realOrResolved(home), realPath)) {
			throw new SpaceError(`Space "${name}" holds the ${home === agentHome ? "current" : "base"} home ${home}; it cannot be ${past}.`);
		}
	}
	return path;
}

/** Deletes a space after checkRemovable. */
export function removeSpace(dir: string, name: string, agentHome: string, protect: string[] = [], userHome: string = osHomedir()): void {
	rmSync(checkRemovable(dir, name, agentHome, protect, userHome), { recursive: true, force: true });
}

/** The folder inside the spaces folder that holds removed spaces; its leading dot keeps it from being a space. */
export const BACKUPS = ".backups";

/**
 * Removes a space by moving it to <spaces folder>/.backups/<name>-<UTC time>, after checkRemovable.
 * Returns the backup's path. A second backup in the same second gets a number; nothing is overwritten.
 */
export function backupSpace(
	dir: string,
	name: string,
	agentHome: string,
	protect: string[] = [],
	userHome: string = osHomedir(),
	now: Date = new Date(),
): string {
	const from = checkRemovable(dir, name, agentHome, protect, userHome);
	const folder = join(dir, BACKUPS);
	if ((existsSync(folder) || isSymlink(folder)) && !isRealFolder(folder)) {
		throw new SpaceError(`The backups folder ${folder} is not a folder; move it away and try again.`);
	}
	try {
		mkdirSync(folder, { recursive: true });
	} catch (error) {
		throw backupFailed(name, error);
	}
	const stamp = `${now.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
	let to = join(folder, `${name}-${stamp}`);
	for (let n = 2; existsSync(to) || isSymlink(to); n++) to = join(folder, `${name}-${stamp}-${n}`);
	// Inside the spaces folder, so the same filesystem: a rename, never a copy.
	try {
		renameSync(from, to);
	} catch (error) {
		throw backupFailed(name, error);
	}
	return to;
}

function backupFailed(name: string, error: unknown): SpaceError {
	const reason = error instanceof Error ? error.message : String(error);
	return new SpaceError(`Could not back up space "${name}": ${reason}. The space was not removed; fix that, or remove it without a backup with --no-backup.`);
}

/** Renames a space after the same safety checks as removal. The new name must be free. */
export function renameSpace(dir: string, oldName: string, newName: string, agentHome: string, protect: string[] = [], userHome: string = osHomedir()): void {
	assertName(oldName);
	assertName(newName);
	const from = checkRemovable(dir, oldName, agentHome, protect, userHome, "rename");
	const to = join(dir, newName);
	if (existsSync(to) || isSymlink(to)) throw new SpaceError(`Space "${newName}" already exists.`);
	renameSync(from, to);
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

/** The name in a local package folder's package.json, or undefined when there is none. */
function localPackageName(folder: string): string | undefined {
	try {
		const name = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"))?.name;
		return typeof name === "string" ? name : undefined;
	} catch {
		return undefined;
	}
}

function samePath(a: string, b: string): boolean {
	return realOrResolved(a) === realOrResolved(b);
}

/**
 * This package's declaration in the current home's settings.json, so a new space loads it the same way.
 * A local path matches when it is the package folder or another folder whose package.json has this package's name,
 * and is made absolute. Without a match (for example when loaded with -e), the fallback, which is the package folder itself
 * unless given. An empty packageRoot (unknown folder) matches a local path only by its package.json name.
 */
export function findOwnDeclaration(
	agentHome: string,
	packageName: string,
	packageRoot: string,
	fallback: PackageDeclaration = packageRoot,
): PackageDeclaration {
	let packages: unknown;
	try {
		packages = JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8"))?.packages;
	} catch {
		return fallback;
	}
	if (!Array.isArray(packages)) return fallback;
	const repo = packageName.split("/").pop() ?? packageName;
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : undefined;
		if (source === undefined) continue;
		let match: string | undefined;
		if (source.startsWith("npm:")) {
			if (npmName(source) === packageName) match = source;
		} else if (isLocalSource(source)) {
			const absolute = isAbsolute(source) ? source : resolve(agentHome, expandTilde(source, osHomedir()));
			if ((packageRoot !== "" && samePath(absolute, packageRoot)) || localPackageName(absolute) === packageName) match = absolute;
		} else if (gitRepoName(source) === repo) {
			match = source;
		}
		if (match !== undefined) return typeof entry === "string" ? match : { ...entry, source: match };
	}
	return fallback;
}
