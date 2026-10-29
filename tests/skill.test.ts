import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the package ships the pi-spaces skill with valid frontmatter", () => {
	assert.deepEqual(pkg.pi.skills, ["./skills"]);
	assert.ok(pkg.files.includes("skills"));
	const path = join(root, "skills", "pi-spaces", "SKILL.md");
	assert.ok(existsSync(path), `${path} is missing`);
	const frontmatter = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
	assert.match(frontmatter, /^name: pi-spaces$/m);
	const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? "";
	assert.ok(description.length > 0 && description.length <= 1024, "description must be 1-1024 characters");
	for (const word of ["PI_SPACE", "PI_SPACE_HOME", "PI_SPACES_COMMAND", "/space"]) assert.ok(description.includes(word), `description names ${word}`);
});
