import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	activeSpace,
	createSpace,
	findOwnDeclaration,
	listSpaces,
	removeSpace,
	renameSpace,
	SpaceError,
	spacesDir,
	validateName,
} from "../src/spaces.ts";

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
}

test("spacesDir uses PI_SPACES_DIR, else ~/.pi/spaces", () => {
	assert.equal(spacesDir({ PI_SPACES_DIR: "/x/spaces" }, "/home/u"), "/x/spaces");
	assert.equal(spacesDir({}, "/home/u"), join("/home/u", ".pi", "spaces"));
	assert.equal(spacesDir({ PI_SPACES_DIR: "~/s" }, "/home/u"), join("/home/u", "s"));
	assert.equal(spacesDir({ PI_SPACES_DIR: "rel/s" }, "/home/u"), join("/home/u", "rel", "s"));
});

test("validateName accepts the documented names and rejects the rest", () => {
	for (const ok of ["work", "a", "9", "my-space_2", "a".repeat(64)]) assert.equal(validateName(ok), undefined, ok);
	const invalid = (n: string) =>
		`Invalid space name "${n}": use lowercase letters, digits, "-" and "_", starting with a letter or digit (at most 64 characters).`;
	for (const bad of ["", "Work", "-a", "_a", "a b", "a/b", "..", ".a", "a".repeat(65)]) assert.equal(validateName(bad), invalid(bad), bad);
	assert.equal(validateName("base"), '"base" is reserved for the home Pi started with.');
});

test("listSpaces returns sorted valid folders and skips files, symlinks and invalid names", () => {
	const root = scratch();
	const dir = join(root, "spaces");
	assert.deepEqual(listSpaces(dir), []);
	mkdirSync(join(dir, "zeta"), { recursive: true });
	mkdirSync(join(dir, "alpha"));
	mkdirSync(join(dir, "Bad"));
	writeFileSync(join(dir, "file"), "");
	mkdirSync(join(root, "elsewhere"));
	symlinkSync(join(root, "elsewhere"), join(dir, "link"));
	assert.deepEqual(listSpaces(dir), ["alpha", "zeta"]);
});

test("activeSpace is the space whose folder is the agent home", () => {
	const root = scratch();
	const dir = join(root, "spaces");
	mkdirSync(join(dir, "work"), { recursive: true });
	assert.equal(activeSpace(dir, join(dir, "work")), "work");
	assert.equal(activeSpace(dir, join(dir, "work") + "/"), "work");
	assert.equal(activeSpace(dir, join(root, "agent")), undefined);
	assert.equal(activeSpace(dir, join(dir, "missing")), undefined);
	assert.equal(activeSpace(dir, join(dir, "work", "nested")), undefined);
});

test("createSpace makes the folder and a settings.json carrying the declaration", () => {
	const dir = join(scratch(), "spaces");
	const path = createSpace(dir, "work", "npm:@jals1212/pi-spaces@0.1.0");
	assert.equal(path, join(dir, "work"));
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "work", "settings.json"), "utf8")), {
		packages: ["npm:@jals1212/pi-spaces@0.1.0"],
	});
});

test("createSpace refuses invalid, reserved and existing names and leaves the folder unchanged", () => {
	const dir = join(scratch(), "spaces");
	createSpace(dir, "work", "npm:@jals1212/pi-spaces");
	writeFileSync(join(dir, "work", "marker"), "keep");
	assert.throws(() => createSpace(dir, "work", "x"), new SpaceError('Space "work" already exists.'));
	assert.equal(readFileSync(join(dir, "work", "marker"), "utf8"), "keep");
	assert.throws(() => createSpace(dir, "Bad", "x"), (e: Error) => e instanceof SpaceError && e.message === validateName("Bad"));
	assert.throws(() => createSpace(dir, "base", "x"), new SpaceError('"base" is reserved for the home Pi started with.'));
	assert.deepEqual(listSpaces(dir), ["work"]);
});

test("removeSpace deletes a space and refuses the active one, base, missing names and symlinks", () => {
	const root = scratch();
	const dir = join(root, "spaces");
	createSpace(dir, "work", "x");
	createSpace(dir, "other", "x");
	const agentHome = join(dir, "other");

	assert.throws(() => removeSpace(dir, "other", agentHome), new SpaceError('Space "other" is active; switch to another space before removing it.'));
	assert.throws(() => removeSpace(dir, "base", agentHome), new SpaceError('"base" is reserved for the home Pi started with.'));
	assert.throws(() => removeSpace(dir, "ghost", agentHome), new SpaceError('Space "ghost" does not exist.'));

	mkdirSync(join(root, "precious"));
	writeFileSync(join(root, "precious", "data"), "keep");
	symlinkSync(join(root, "precious"), join(dir, "link"));
	assert.throws(() => removeSpace(dir, "link", agentHome), new SpaceError(`Space "link" is not a folder inside ${dir}; remove it by hand.`));
	assert.equal(readFileSync(join(root, "precious", "data"), "utf8"), "keep");

	removeSpace(dir, "work", agentHome);
	assert.equal(existsSync(join(dir, "work")), false);
	assert.deepEqual(listSpaces(dir), ["other"]);
});

test("removeSpace refuses a spaces folder reached through a symlinked space", () => {
	const root = scratch();
	const real = join(root, "real-spaces");
	mkdirSync(join(real, "work"), { recursive: true });
	const dir = join(root, "spaces");
	mkdirSync(dir);
	symlinkSync(join(real, "work"), join(dir, "work"));
	assert.throws(() => removeSpace(dir, "work", join(root, "agent")), SpaceError);
	assert.equal(existsSync(join(real, "work")), true);
});

test("removeSpace refuses the active space when reached through a symlinked spaces folder", () => {
	const root = scratch();
	mkdirSync(join(root, "real", "z"), { recursive: true });
	symlinkSync(join(root, "real"), join(root, "link"));
	assert.equal(activeSpace(join(root, "link"), join(root, "real", "z")), "z");
	assert.throws(() => removeSpace(join(root, "link"), "z", join(root, "real", "z")), /active/);
	assert.ok(existsSync(join(root, "real", "z")));
});

test("removeSpace refuses when the spaces folder is the agent home or inside it", () => {
	const root = scratch();
	const agent = join(root, "agent");
	mkdirSync(join(agent, "sessions"), { recursive: true });
	mkdirSync(join(agent, "nested", "x"), { recursive: true });
	const message = new SpaceError(`The spaces folder ${agent} is the agent home or inside it; set PI_SPACES_DIR to a folder outside it.`);
	assert.throws(() => removeSpace(agent, "sessions", agent), message);
	assert.throws(() => removeSpace(join(agent, "nested"), "x", agent), SpaceError);
	assert.ok(existsSync(join(agent, "sessions")));
	assert.ok(existsSync(join(agent, "nested", "x")));
});

test("removeSpace refuses a spaces folder that is the filesystem root or the user's home", () => {
	const unsafe = (dir: string) => new SpaceError(`The spaces folder ${dir} is not a dedicated folder; set PI_SPACES_DIR to one.`);
	const root = scratch();
	const home = join(root, "home");
	mkdirSync(join(home, "docs"), { recursive: true });
	assert.throws(() => removeSpace(home, "docs", join(root, "agent"), [], home), unsafe(home));
	assert.throws(() => removeSpace("/", "tmp", join(root, "agent"), [], home), unsafe("/"));
	assert.ok(existsSync(join(home, "docs")));
});

test("removeSpace refuses a space that is or contains the base home", () => {
	const root = scratch();
	const dir = join(root, "pi");
	mkdirSync(join(dir, "agent"), { recursive: true });
	mkdirSync(join(dir, "work"));
	const base = join(dir, "agent");
	const message = new SpaceError(`Space "agent" holds the base home ${base}; it cannot be removed.`);
	assert.throws(() => removeSpace(dir, "agent", join(dir, "work"), [base]), message);
	assert.ok(existsSync(base));
});

test("findOwnDeclaration copies this package's entry from the current settings", () => {
	const root = scratch();
	const agent = join(root, "agent");
	const own = join(root, "pkg");
	mkdirSync(agent);
	mkdirSync(own);
	const write = (packages: unknown[]) => writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages }));
	const name = "@jals1212/pi-spaces";

	write(["npm:other", "npm:@jals1212/pi-spaces@0.1.0"]);
	assert.deepEqual(findOwnDeclaration(agent, name, own), "npm:@jals1212/pi-spaces@0.1.0");

	write([{ source: "npm:@jals1212/pi-spaces", skills: [] }]);
	assert.deepEqual(findOwnDeclaration(agent, name, own), { source: "npm:@jals1212/pi-spaces", skills: [] });

	write(["git:github.com/jals1212/pi-spaces@v1"]);
	assert.deepEqual(findOwnDeclaration(agent, name, own), "git:github.com/jals1212/pi-spaces@v1");

	write(["../pkg"]);
	assert.deepEqual(findOwnDeclaration(agent, name, own), own);

	write([{ source: "../pkg", extensions: ["extensions/spaces.ts"] }]);
	assert.deepEqual(findOwnDeclaration(agent, name, own), { source: own, extensions: ["extensions/spaces.ts"] });
});

test("findOwnDeclaration falls back to the package folder when no entry matches", () => {
	const root = scratch();
	const agent = join(root, "agent");
	mkdirSync(agent);
	assert.equal(findOwnDeclaration(agent, "@jals1212/pi-spaces", "/opt/pkg"), "/opt/pkg");
	writeFileSync(join(agent, "settings.json"), "{ not json");
	assert.equal(findOwnDeclaration(agent, "@jals1212/pi-spaces", "/opt/pkg"), "/opt/pkg");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:@jals1212/pi-spaces-extra"] }));
	assert.equal(findOwnDeclaration(agent, "@jals1212/pi-spaces", "/opt/pkg"), "/opt/pkg");
});

test("renameSpace moves the folder and keeps its contents", () => {
	const root = scratch();
	const dir = join(root, "spaces");
	createSpace(dir, "a", "x");
	createSpace(dir, "keep", "x");
	writeFileSync(join(dir, "a", "auth.json"), "secret");
	renameSpace(dir, "a", "b", join(root, "agent"));
	assert.equal(existsSync(join(dir, "a")), false);
	assert.equal(readFileSync(join(dir, "b", "auth.json"), "utf8"), "secret");
	assert.deepEqual(listSpaces(dir), ["b", "keep"]);
});

test("renameSpace refuses base on either side, invalid, missing, existing and same names, leaving folders unchanged", () => {
	const root = scratch();
	const dir = join(root, "spaces");
	const agent = join(root, "agent");
	createSpace(dir, "a", "x");
	createSpace(dir, "b", "x");
	assert.throws(() => renameSpace(dir, "base", "c", agent), new SpaceError('"base" is reserved for the home Pi started with.'));
	assert.throws(() => renameSpace(dir, "a", "base", agent), new SpaceError('"base" is reserved for the home Pi started with.'));
	assert.throws(() => renameSpace(dir, "a", "Bad", agent), /Invalid space name "Bad"/);
	assert.throws(() => renameSpace(dir, "ghost", "c", agent), new SpaceError('Space "ghost" does not exist.'));
	assert.throws(() => renameSpace(dir, "a", "b", agent), new SpaceError('Space "b" already exists.'));
	assert.throws(() => renameSpace(dir, "a", "a", agent), new SpaceError('Space "a" already exists.'));
	assert.deepEqual(listSpaces(dir), ["a", "b"]);
	assert.equal(existsSync(join(dir, "c")), false);
});

test("renameSpace refuses the active space, symlinks and a space holding the current or base home", () => {
	const root = scratch();
	const dir = join(root, "pi");
	createSpace(dir, "work", "x");
	mkdirSync(join(dir, "agent"));
	assert.throws(
		() => renameSpace(dir, "work", "z", join(dir, "work")),
		new SpaceError('Space "work" is active; switch to another space before renaming it.'),
	);
	const base = join(dir, "agent");
	assert.throws(
		() => renameSpace(dir, "agent", "z", join(dir, "work"), [base]),
		new SpaceError(`Space "agent" holds the base home ${base}; it cannot be renamed.`),
	);
	mkdirSync(join(root, "precious"));
	symlinkSync(join(root, "precious"), join(dir, "link"));
	assert.throws(
		() => renameSpace(dir, "link", "z", join(root, "agent")),
		new SpaceError(`Space "link" is not a folder inside ${dir}; rename it by hand.`),
	);
	assert.deepEqual(listSpaces(dir), ["agent", "work"]);
	assert.equal(existsSync(join(dir, "z")), false);
	assert.ok(existsSync(join(root, "precious")));
});
