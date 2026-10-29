import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addSpaceSection, exportSpaceInfo, spaceInfo, spacePrompt } from "../src/context.ts";
import { createSpace } from "../src/spaces.ts";

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-")));
	const dir = join(root, "spaces");
	const base = join(root, "agent");
	mkdirSync(base);
	createSpace(dir, "work", "npm:@jals1212/pi-spaces");
	return { dir, base, work: join(dir, "work") };
}

test("spaceInfo names the active space, its home and the configured command", () => {
	const { dir, work } = setup();
	assert.deepEqual(spaceInfo(dir, work, { PI_SPACES_COMMAND: "my-launcher --" }), { space: "work", home: work, command: "my-launcher --" });
});

test("spaceInfo in the base home has no space, and the command defaults to pi", () => {
	const { dir, base } = setup();
	assert.deepEqual(spaceInfo(dir, base, {}), { space: undefined, home: base, command: "pi" });
	assert.equal(spaceInfo(dir, base, { PI_SPACES_COMMAND: "  " }).command, "pi");
});

test("exportSpaceInfo sets PI_SPACE, PI_SPACE_HOME and PI_SPACES_COMMAND", () => {
	const env: Record<string, string | undefined> = { OTHER: "kept" };
	exportSpaceInfo(env, { space: "work", home: "/h/spaces/work", command: "pi" });
	assert.deepEqual(env, { OTHER: "kept", PI_SPACE: "work", PI_SPACE_HOME: "/h/spaces/work", PI_SPACES_COMMAND: "pi" });
});

test("exportSpaceInfo in the base home removes a stale PI_SPACE and keeps a configured command", () => {
	const env: Record<string, string | undefined> = { PI_SPACE: "old", PI_SPACES_COMMAND: "my-launcher --" };
	exportSpaceInfo(env, { space: undefined, home: "/h/agent", command: "my-launcher --" });
	assert.deepEqual(env, { PI_SPACE_HOME: "/h/agent", PI_SPACES_COMMAND: "my-launcher --" });
});

test("spacePrompt tells the model the space, the home and the command", () => {
	assert.equal(
		spacePrompt({ space: "work", home: "/h/spaces/work", command: "pi" }),
		[
			'This Pi runs in the space "work" (PI_SPACE).',
			"Agent home: /h/spaces/work (PI_SPACE_HOME).",
			"Command that starts Pi: pi (PI_SPACES_COMMAND); `pi --space <name>` starts it in a space, and `/space` lists, creates, removes and switches spaces.",
		].join("\n"),
	);
	assert.equal(
		spacePrompt({ space: undefined, home: "/h/agent", command: "my-launcher --" }),
		[
			"This Pi runs in the base home, outside any space.",
			"Agent home: /h/agent (PI_SPACE_HOME).",
			"Command that starts Pi: my-launcher -- (PI_SPACES_COMMAND); `my-launcher -- --space <name>` starts it in a space, and `/space` lists, creates, removes and switches spaces.",
		].join("\n"),
	);
});

test("addSpaceSection adds the pi_space prompt section and never replaces the prompt", () => {
	const info = { space: "work", home: "/h/spaces/work", command: "pi" };
	const options = { sections: { other: "kept" } as Record<string, string> };
	addSpaceSection(options, info);
	assert.deepEqual(options.sections, { other: "kept", pi_space: spacePrompt(info) });
	const bare: { sections?: Record<string, string> } = {};
	addSpaceSection(bare, info);
	assert.deepEqual(bare.sections, { pi_space: spacePrompt(info) });
	assert.doesNotThrow(() => addSpaceSection(undefined, info));
});
