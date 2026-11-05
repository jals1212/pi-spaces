import assert from "node:assert/strict";
import { test } from "node:test";
import type { Profile } from "../src/config.ts";
import { profileCommand, setupCommand, splitCommand } from "../src/launch.ts";

const profile = (commands?: { base: string; space?: string }): Profile => ({
	name: "ml",
	home: "/h/agent",
	dir: "/h/spaces",
	...(commands ? { commands } : {}),
});
const base = { space: undefined, targetHome: "/h/agent", spaceRoot: "/h", baseHome: "/h/agent" };
const work = { space: "work", targetHome: "/h/spaces/work", spaceRoot: "/h/spaces/work", baseHome: "/h/agent" };
const rooted = { space: "work", targetHome: "/h/spaces/work/agent", spaceRoot: "/h/spaces/work", baseHome: "/h/agent" };

test("base runs commands.base with {home} and {name} filled with the base home and base", () => {
	assert.deepEqual(profileCommand(profile({ base: "my-launcher" }), base), { command: "my-launcher", args: [] });
	assert.deepEqual(profileCommand(profile({ base: "my-launcher --home {home} --as {name}" }), base), {
		command: "my-launcher",
		args: ["--home", "/h/agent", "--as", "base"],
	});
});

test("a space runs commands.space filled with the space's home and name", () => {
	assert.deepEqual(profileCommand(profile({ base: "my-launcher", space: "my-launcher --home {home} --name {name}" }), work), {
		command: "my-launcher",
		args: ["--home", "/h/spaces/work", "--name", "work"],
	});
});

test("a space without commands.space runs <base> --space <name>", () => {
	assert.deepEqual(profileCommand(profile({ base: "my-launcher --fast" }), work), { command: "my-launcher", args: ["--fast", "--space", "work"] });
});

test("a profile without commands, or no profile, gives undefined", () => {
	assert.equal(profileCommand(profile(), base), undefined);
	assert.equal(profileCommand(profile(), work), undefined);
	assert.equal(profileCommand(undefined, base), undefined);
	assert.equal(profileCommand(undefined, work), undefined);
});

test("quotes keep spaces in a word and are removed; a $ stays literal", () => {
	assert.deepEqual(splitCommand(`my-launcher "a b" 'c d' ""`), ["my-launcher", "a b", "c d", ""]);
	assert.deepEqual(setupCommand("run {home} {name}", "/h/$&x", "n$1"), { program: "run", args: ["/h/$&x", "n$1"] });
	assert.deepEqual(profileCommand(profile({ base: `"/my tools/my-launcher" --home "{home}"` }), { ...base, targetHome: "/h/a b", baseHome: "/h/a b" }), {
		command: "/my tools/my-launcher",
		args: ["--home", "/h/a b"],
	});
});

test("an unclosed quote throws", () => {
	assert.throws(() => splitCommand(`my-launcher "oops`), { message: 'the command has an unclosed " quote' });
	assert.throws(() => profileCommand(profile({ base: "my-launcher 'oops" }), base), { message: "the command has an unclosed ' quote" });
});

test("{space} is the space root: for a rooted space its folder above the agent home, for a flat one the home, in base the parent of the base home", () => {
	const template = { base: "my-launcher --config {space}/cfg", space: "my-launcher --home {home} --space-dir {space} --name {name}" };
	assert.deepEqual(profileCommand(profile(template), rooted), { command: "my-launcher", args: ["--home", "/h/spaces/work/agent", "--space-dir", "/h/spaces/work", "--name", "work"] });
	assert.deepEqual(profileCommand(profile(template), work), { command: "my-launcher", args: ["--home", "/h/spaces/work", "--space-dir", "/h/spaces/work", "--name", "work"] });
	assert.deepEqual(profileCommand(profile(template), base), { command: "my-launcher", args: ["--config", "/h/cfg"] });
	// Without commands.space, the base command is filled for base and gets --space.
	assert.deepEqual(profileCommand(profile({ base: "my-launcher --config {space}/cfg" }), rooted), { command: "my-launcher", args: ["--config", "/h/cfg", "--space", "work"] });
});

test("setupCommand fills {space} in every word, with the root after the name, and {home} as before", () => {
	assert.deepEqual(setupCommand("run {home} {space} {name} {space}/x", "/s/work/agent", "work", "/s/work"), { program: "run", args: ["/s/work/agent", "/s/work", "work", "/s/work/x"] });
	// A "$" in the root is put in as written.
	assert.deepEqual(setupCommand("run {space}", "/s/$&/agent", "w", "/s/$&"), { program: "run", args: ["/s/$&"] });
	// Without a root (the old three arguments) it is the home: a flat space.
	assert.deepEqual(setupCommand("run {home} {space}", "/s/work", "work"), { program: "run", args: ["/s/work", "/s/work"] });
});
