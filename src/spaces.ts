// Spaces: named Pi agent homes kept side by side in one folder. A space is a root folder with its agent home, `agent`,
// inside it; an old space has no `agent` folder and its root is the agent home (see spaceHome).
// Host-agnostic: everything here relies only on Pi's PI_CODING_AGENT_DIR contract.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export const BASE = "base";
/** The folder inside a space's root that is its agent home. */
export const AGENT = "agent";
/**
 * The file in a new space's root that waits for its setup command: the space is rooted, but its agent home is left to
 * the setup, and the declaration it holds joins the settings.json the setup wrote once the setup succeeds.
 */
export const PENDING = ".pi-space-new";
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SpaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpaceError";
	}
}

export type Env = Record<string, string | undefined>;
export type PackageDeclaration = string | ({ source: string } & Record<string, unknown>);

/** Expands a leading `~` to the given home folder. */
export function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/**
 * The folder that holds every space: PI_SPACES_DIR, else the dir of the profile that matches the base home
 * (an absolute path, from the config file), else a `spaces` folder next to the base home
 * (~/.pi/agent gives ~/.pi/spaces), so every program that runs Pi with its own home keeps its own spaces.
 * The base home is the one Pi started with (PI_SPACES_BASE_HOME inside a space), else Pi's agent home.
 */
export function spacesDir(env: Env = process.env, home: string = osHomedir(), profileDir?: string): string {
	const fromEnv = env.PI_SPACES_DIR;
	// A relative value resolves against the user's home, never the working directory.
	if (fromEnv) return resolve(home, expandTilde(fromEnv, home));
	if (profileDir) return profileDir;
	const agentHome = env.PI_CODING_AGENT_DIR ? expandTilde(env.PI_CODING_AGENT_DIR, home) : join(home, ".pi", "agent");
	const baseHome = env.PI_SPACES_BASE_HOME || agentHome;
	return join(dirname(resolve(baseHome)), "spaces");
}

// The words of the pi-space and /space commands, so a space name never reads as one.
const COMMANDS = new Set(["list", "new", "remove", "rename", "switch", "update", "install", "uninstall", "setup", "completion"]);

/** True when PI_SPACES_SETUP holds a setup command, not just blanks. */
export function hasSetupCommand(env: Env): boolean {
	return (env.PI_SPACES_SETUP ?? "").trim() !== "";
}

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

/**
 * The agent home of the space whose root is `root`: `<root>/agent` when that is a real folder (a symlink or a file named
 * agent does not count) or when the space still waits for its setup (PENDING), else the root itself, an old space whose
 * folder is the agent home. Pi's own agent home never has a folder named agent, so the folder tells the two layouts apart.
 */
export function spaceHome(root: string): string {
	return isRooted(root) ? join(root, AGENT) : root;
}

/** True when the space with this root keeps its agent home in `<root>/agent`, or will once its setup makes it. */
export function isRooted(root: string): boolean {
	return isRealFolder(join(root, AGENT)) || isPending(root);
}

/** True when the space with this root waits for its setup command (its root holds PENDING). */
export function isPending(root: string): boolean {
	return existsSync(join(root, PENDING));
}

/** The space whose agent home is the given one (`<root>/agent`, or the root of an old space), or undefined. */
export function activeSpace(dir: string, agentHome: string): string | undefined {
	for (const name of listSpaces(dir)) {
		if (samePath(spaceHome(join(dir, name)), agentHome)) return name;
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

/**
 * Creates an empty space: its root, with the agent home `agent` inside, whose settings.json declares this package, so
 * /space works inside it. Returns the root.
 */
export function createSpace(dir: string, name: string, declaration: PackageDeclaration): string {
	const path = createSpaceRoot(dir, name);
	declareInHome(join(path, AGENT), declaration);
	return path;
}

/**
 * Creates a space's root alone, without its agent home, so a setup command can make that home itself (a launcher such as
 * gentle-shell only provisions a home it made). Returns the root.
 */
export function createSpaceRoot(dir: string, name: string): string {
	assertName(name);
	const path = join(dir, name);
	if (existsSync(path) || isSymlink(path)) throw new SpaceError(`Space "${name}" already exists.`);
	mkdirSync(dir, { recursive: true });
	mkdirSync(path);
	return path;
}

/**
 * Marks a new space's root as waiting for its setup command, with the declaration to add once it succeeds (none for a
 * space that does not declare this package).
 */
export function markPending(root: string, declaration?: PackageDeclaration): void {
	writeFileSync(join(root, PENDING), `${JSON.stringify(declaration === undefined ? {} : { declaration }, null, 2)}\n`);
}

/**
 * Finishes a space whose setup succeeded: adds the declaration its PENDING file holds to the settings.json of its agent
 * home (making both when the setup did not) and removes the file. False when the space was not waiting for a setup.
 */
export function finishPending(root: string): boolean {
	const file = join(root, PENDING);
	if (!existsSync(file)) return false;
	let pending: { declaration?: PackageDeclaration };
	try {
		pending = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new SpaceError(`${file} is not valid JSON; fix or delete it and run pi-space setup again.`);
	}
	declareInHome(join(root, AGENT), pending.declaration);
	rmSync(file);
	return true;
}

function sourceOf(entry: unknown): string | undefined {
	const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
	return typeof source === "string" ? source : undefined;
}

/** Two package sources name the same package: npm sources by package name, whatever their version; others as written. */
function sameSource(a: string | undefined, b: string | undefined): boolean {
	if (a === undefined || b === undefined) return false;
	if (a.startsWith("npm:") && b.startsWith("npm:")) return npmName(a) === npmName(b);
	return a === b;
}

/**
 * Makes the agent home when it is missing and adds the declaration to its settings.json, keeping everything already
 * there; a package with the same source is not declared twice. Without a declaration it only makes sure the file exists.
 */
export function declareInHome(home: string, declaration?: PackageDeclaration): void {
	mkdirSync(home, { recursive: true });
	const file = join(home, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(file)) {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SpaceError(`${file} is not a JSON object.`);
		settings = parsed as Record<string, unknown>;
		if (!declaration) return;
	}
	if (declaration) {
		if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new SpaceError(`${file} has "packages" that is not a list.`);
		const packages = (settings.packages as unknown[] | undefined) ?? [];
		const wanted = sourceOf(declaration);
		if (packages.some((entry) => sameSource(sourceOf(entry), wanted))) return;
		settings.packages = [...packages, declaration];
	}
	writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
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
	migrate: { gerund: "migrating", past: "migrated" },
};
type Action = keyof typeof ACTIONS;

/**
 * Throws the reason a space cannot be removed (or renamed, or migrated, with that action): base, invalid, missing, active, a spaces folder that is
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
	const to = backupSlot(dir, name, now, (error) => backupFailed(name, error));
	// Inside the spaces folder, so the same filesystem: a rename, never a copy.
	try {
		renameSync(from, to);
	} catch (error) {
		throw backupFailed(name, error);
	}
	return to;
}

/**
 * A free path <spaces folder>/.backups/<name>-<UTC time>, with the backups folder made. A second one in the same second gets a
 * number; nothing is overwritten. `failed` turns a filesystem error into the caller's SpaceError.
 */
function backupSlot(dir: string, name: string, now: Date, failed: (error: unknown) => SpaceError): string {
	const folder = join(dir, BACKUPS);
	if ((existsSync(folder) || isSymlink(folder)) && !isRealFolder(folder)) {
		throw new SpaceError(`The backups folder ${folder} is not a folder; move it away and try again.`);
	}
	try {
		mkdirSync(folder, { recursive: true });
	} catch (error) {
		throw failed(error);
	}
	const stamp = utcStamp(now);
	let to = join(folder, `${name}-${stamp}`);
	for (let n = 2; existsSync(to) || isSymlink(to); n++) to = join(folder, `${name}-${stamp}-${n}`);
	return to;
}

function utcStamp(now: Date): string {
	return `${now.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

function backupFailed(name: string, error: unknown): SpaceError {
	const reason = error instanceof Error ? error.message : String(error);
	return new SpaceError(`Could not back up space "${name}": ${reason}. The space was not removed; fix that, or remove it without a backup with --no-backup.`);
}

export interface Migration {
	/** The space's root: unchanged. */
	root: string;
	/** Its agent home now: `<root>/agent`. */
	home: string;
	/** The copy of the old space, in <spaces folder>/.backups. */
	backup: string;
}

/**
 * Moves an old space (no `agent` folder: its root is its agent home) into `<root>/agent`, after the same safety checks as
 * a rename (not base, not the active space, not one that holds a protected home, a real folder inside the spaces folder) and
 * a space that is already rooted is refused. Steps: copy the space to <spaces folder>/.backups/<name>-<UTC time> (the original
 * stays); rename the root to a hidden staging name (<spaces folder>/.migrate-<name>-<UTC time>), which listSpaces does not
 * list; make the root again; rename the staging folder to `<root>/agent`. When a rename fails the renames are undone and
 * the backup is kept. `rename` is the move, so a test can make one fail.
 */
export function migrateSpace(
	dir: string,
	name: string,
	agentHome: string,
	protect: string[] = [],
	userHome: string = osHomedir(),
	now: Date = new Date(),
	rename: typeof renameSync = renameSync,
): Migration {
	assertName(name);
	const root = join(dir, name);
	if (isPending(root)) throw new SpaceError(`Space "${name}" is waiting for its setup command, which makes its agent home; run pi-space setup.`);
	if (isRooted(root)) throw new SpaceError(`Space "${name}" already has its agent home in ${join(root, AGENT)}.`);
	checkRemovable(dir, name, agentHome, protect, userHome, "migrate");
	const home = join(root, AGENT);
	const backup = backupSlot(dir, name, now, (error) => migrateFailed(name, error, "The space was not changed."));
	try {
		// Links stay links: the copy is the space as it was.
		cpSync(root, backup, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
	} catch (error) {
		rmSync(backup, { recursive: true, force: true });
		throw migrateFailed(name, error, "The space was not changed.");
	}
	let staging = join(dir, `.migrate-${name}-${utcStamp(now)}`);
	for (let n = 2; existsSync(staging) || isSymlink(staging); n++) staging = join(dir, `.migrate-${name}-${utcStamp(now)}-${n}`);
	let moved = false;
	let made = false;
	try {
		rename(root, staging);
		moved = true;
		mkdirSync(root);
		made = true;
		rename(staging, home);
	} catch (error) {
		// Undo, in reverse: the new root goes (it is empty), then the content comes back.
		try {
			if (made) rmdirSync(root);
			if (moved) rename(staging, root);
		} catch (undo) {
			throw migrateFailed(name, error, `It could not be put back (${undo instanceof Error ? undo.message : String(undo)}): its content is in ${staging}; move it back to ${root} by hand. Its backup is ${backup}.`);
		}
		throw migrateFailed(name, error, `The space was put back as it was; its backup is ${backup}.`);
	}
	return { root, home, backup };
}

function migrateFailed(name: string, error: unknown, after: string): SpaceError {
	const reason = error instanceof Error ? error.message : String(error);
	return new SpaceError(`Could not migrate space "${name}": ${reason}. ${after}`);
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

/** True when both paths are the same place: real paths when they exist, resolved paths otherwise. */
export function samePath(a: string, b: string): boolean {
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
