// A space pinned to a folder, like .nvmrc: <folder>/.pi/pi-space/space holds one line, <profile>/<name>, next to a
// .gitignore that ignores the whole pi-space folder, itself included. .pi itself is Pi's project folder and is never
// touched. Shared by the pi-space command (pin, unpin, a bare pi-space) and /space pin and /space unpin.
// A marker may come with a cloned repository: nothing is written or removed through a symbolic link, and a marker
// whose line holds control or bidi characters names nothing (it is never echoed to a terminal).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { samePath } from "./spaces.ts";

export const PIN_FOLDER = join(".pi", "pi-space");
export const PIN_FILE = "space";
export const PIN_IGNORE = ".gitignore";
export const PIN_IGNORE_TEXT = "# pi-space: this folder is local to this machine; this file ignores all of it, itself included.\n*\n";

/** Why a pin or unpin did not happen; `code` is the exit status pi-space gives it (2: the home folder, 1: anything else). */
export class PinError extends Error {
	readonly code: 1 | 2;
	constructor(message: string, code: 1 | 2) {
		super(message);
		this.code = code;
	}
}

/** Whether `path` is a file, following links; false for anything that cannot be read as one. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Whether `path` is a symbolic link itself (not followed); false when there is nothing there. */
function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * The marker that applies in `from`: the first <folder>/.pi/pi-space/space file from it upwards. The home folder is
 * skipped: its .pi is Pi's own folder, not a project.
 */
export function findPin(from: string, home: string): string | undefined {
	for (let folder = resolve(from); ; folder = dirname(folder)) {
		const file = join(folder, PIN_FOLDER, PIN_FILE);
		if (!samePath(folder, home) && isFile(file)) return file;
		if (dirname(folder) === folder) return undefined;
	}
}

/** Control characters (C0, DEL, C1) and the bidi controls that could rewrite what the terminal shows. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * What a marker names: `name` when it holds exactly one `<profile>/<name>` (blank lines and # comments left out),
 * neither when it does not, and `error` when it cannot be read.
 */
export function readPin(file: string): { name?: string; error?: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return { error: (error as Error).message };
	}
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	if (lines.length !== 1 || UNSAFE.test(lines[0])) return {};
	const slash = lines[0].indexOf("/");
	return slash > 0 && slash < lines[0].length - 1 ? { name: lines[0] } : {};
}

/** The real path of a folder, links and Windows short names (RUNNER~1) resolved; the path itself when it cannot be read. */
function realFolder(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Where pin and unpin work: the root of the git repository of `cwd`, else `cwd` (also when git is missing or hangs).
 * The root is `cwd` or the folder above it that git names, spelled as `cwd` is: git gives the real path, which on
 * Windows may be the long form of a short name, and on macOS /private/var for /var.
 */
export function pinRoot(cwd: string): string {
	const here = resolve(cwd);
	const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
	const top = git.status === 0 ? git.stdout.trim() : "";
	if (top === "") return here;
	const real = realFolder(top);
	for (let folder = here; ; folder = dirname(folder)) {
		if (samePath(realFolder(folder), real)) return folder;
		if (dirname(folder) === folder) return resolve(top);
	}
}

/** The refusal of the home folder, whose .pi is Pi's own folder; undefined for any other root. */
export function homeRefusal(root: string, home: string): string | undefined {
	return samePath(root, home) ? `${root} is your home folder, where .pi is Pi's own folder; pin a space in a project folder.` : undefined;
}

/** The first of .pi, .pi/pi-space and the given files in it that is a symbolic link. */
function linkIn(owner: string, files: string[]): string | undefined {
	const folder = join(owner, PIN_FOLDER);
	return [dirname(folder), folder, ...files.map((name) => join(folder, name))].find(isLink);
}

/** Whether `path` is `folder` or inside it. */
function isWithin(path: string, folder: string): boolean {
	const rel = relative(folder, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface Pinned {
	name: string;
	file: string;
	/** The space the marker named before, when another. */
	previous?: string;
}

/**
 * Pins `name` (`<profile>/<name>`, already known to exist) to the repository of `cwd`: writes the marker, and its
 * .gitignore when there is none. The marker is written to a temporary file and renamed over the old one, so a failure
 * leaves it as it was; a folder this call made is removed again. Throws a PinError for the home folder, a symbolic
 * link, or a write that fails.
 */
export function writePin(cwd: string, home: string, name: string): Pinned {
	const root = pinRoot(cwd);
	const refusal = homeRefusal(root, home);
	if (refusal !== undefined) throw new PinError(refusal, 2);
	const link = linkIn(root, [PIN_FILE, PIN_IGNORE]);
	if (link !== undefined) throw new PinError(`${link} is a symbolic link; pi-space does not write through it.`, 1);
	const folder = join(root, PIN_FOLDER);
	const file = join(folder, PIN_FILE);
	const before = isFile(file) ? readPin(file).name : undefined;
	const temporary = join(folder, `.${PIN_FILE}-${process.pid}.tmp`);
	let made: string | undefined;
	try {
		made = mkdirSync(folder, { recursive: true });
		const ignore = join(folder, PIN_IGNORE);
		if (!existsSync(ignore)) writeFileSync(ignore, PIN_IGNORE_TEXT, { flag: "wx" });
		writeFileSync(temporary, `${name}\n`, { flag: "wx" });
		renameSync(temporary, file);
	} catch (error) {
		// Cleaning up must not hide the reason: a path under a file (ENOTDIR) cannot be removed either.
		try {
			if (made !== undefined) rmSync(made, { recursive: true, force: true });
			else rmSync(temporary, { force: true });
		} catch {}
		throw new PinError(`cannot write ${file}: ${(error as Error).message}`, 1);
	}
	return { name, file, ...(before !== undefined && before !== name ? { previous: before } : {}) };
}

/** The line that reports a pin. */
export function pinnedMessage({ name, file, previous }: Pinned): string {
	return `Pinned ${name} in ${file}${previous !== undefined ? ` (was ${previous})` : ""}.`;
}

export type Unpinned =
	| { kind: "none"; root: string; inherited?: string }
	| { kind: "removed"; label: string; file: string; folder: string; folderRemoved: boolean };

/**
 * Removes the marker that applies in `cwd` when it is inside the repository of `cwd` (else `cwd` itself), the
 * .gitignore pin wrote, and the folder once empty (and .pi, when nothing else is in it). A marker of a folder above is
 * reported as inherited and left. Throws a PinError for a symbolic link or a removal that fails.
 */
export function removePin(cwd: string, home: string): Unpinned {
	const root = pinRoot(cwd);
	const here = findPin(cwd, home);
	// <owner>/.pi/pi-space/space: the folder the marker belongs to.
	const owner = here === undefined ? undefined : dirname(dirname(dirname(here)));
	if (here === undefined || owner === undefined || !isWithin(owner, root)) return { kind: "none", root, ...(here !== undefined ? { inherited: here } : {}) };
	const link = linkIn(owner, []);
	if (link !== undefined) throw new PinError(`${link} is a symbolic link; pi-space does not remove through it.`, 1);
	const folder = dirname(here);
	const { name, error } = readPin(here);
	const label = name ?? (error !== undefined ? "an unreadable marker" : "an invalid marker");
	try {
		rmSync(here);
		const ignore = join(folder, PIN_IGNORE);
		if (isFile(ignore) && !isLink(ignore) && readFileSync(ignore, "utf8") === PIN_IGNORE_TEXT) rmSync(ignore);
		if (readdirSync(folder).length > 0) return { kind: "removed", label, file: here, folder, folderRemoved: false };
		rmdirSync(folder);
		// A .pi that pin made and that holds nothing else goes too; one with anything in it is Pi's and stays.
		if (readdirSync(dirname(folder)).length === 0) rmdirSync(dirname(folder));
		return { kind: "removed", label, file: here, folder, folderRemoved: true };
	} catch (error) {
		throw new PinError(`cannot remove ${here}: ${(error as Error).message}`, 1);
	}
}

/** The line that reports an unpin. */
export function unpinnedMessage(result: Unpinned): string {
	if (result.kind === "none") return `No space pinned in ${result.root}${result.inherited !== undefined ? `; the one here comes from ${result.inherited}` : ""}.`;
	return result.folderRemoved
		? `Unpinned ${result.label} (removed ${result.folder}).`
		: `Unpinned ${result.label} (removed ${result.file}; ${result.folder} holds other files and stays).`;
}
