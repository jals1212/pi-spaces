// Builds dist/: the src/*.ts modules as plain JavaScript, for the CLI package
// (@jals1212/pi-spaces-cli), which imports the core as '@jals1212/pi-spaces/spaces' and '@jals1212/pi-spaces/config'
// (every src/*.ts module is built; package.json "exports" names the public ones).
// Node does not strip TypeScript types from files under node_modules, so an
// installed package cannot import src/*.ts; Pi loads the extension's TypeScript itself.
// Types are erased in place (same line and column), and ".ts" imports become ".js".
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const file of readdirSync(src).filter((name) => name.endsWith(".ts"))) {
	const code = stripTypeScriptTypes(readFileSync(join(src, file), "utf8"), { mode: "strip" });
	const js = code.replace(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.js$2");
	writeFileSync(join(dist, file.replace(/\.ts$/, ".js")), js);
}
