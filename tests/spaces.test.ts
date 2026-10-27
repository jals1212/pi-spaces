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
