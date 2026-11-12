import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Needs `npm run build` first, which `npm test` does.
test("the package exports the built spaces, config and pin modules", async () => {
	assert.deepEqual(pkg.exports, { "./spaces": "./dist/spaces.js", "./config": "./dist/config.js", "./pin": "./dist/pin.js", "./package.json": "./package.json" });
	const config = await import("pi-spaces/config");
	assert.equal(config.SCHEMA, "pi-spaces.config/v2");
	assert.equal(typeof config.loadConfig, "function");
	assert.equal(typeof config.ConfigError, "function");
	const pin = await import("pi-spaces/pin");
	assert.equal(typeof pin.writePin, "function");
	assert.equal(typeof pin.removePin, "function");
	const spaces = await import("pi-spaces/spaces");
	assert.equal(typeof spaces.spacesDir, "function");
});
