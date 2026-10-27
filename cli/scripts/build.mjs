// Builds dist/cli.js: src/cli.ts as plain JavaScript, for the installed
// `pi-space` bin (Node does not strip TypeScript types under node_modules).
// Types are erased in place (same line and column), and ".ts" imports become ".js".
// The core is imported as '@jals1212/pi-spaces/spaces' and stays so.
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
