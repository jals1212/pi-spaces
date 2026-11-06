// The Pi extension itself (extensions/spaces.ts), loaded with a stand-in Pi: that its session_start shows the space
// in Herdr's sidebar (the pane's `space` token) and in herdr-app's (the terminal's `space` label), and that
// session_shutdown takes both back. Herdr is a fake socket, `hc` a script on PATH that logs its arguments.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createSpace } from "../src/spaces.ts";

const HERDR_VARS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HC_TERMINAL_ID"];
// Tests run in whatever pane they are started from: never report to a real Herdr or herdr-app.
for (const name of HERDR_VARS) delete process.env[name];

register(new URL("./fixture/pi-stubs/hooks.mjs", import.meta.url));
const extension = (await import("../extensions/spaces.ts")).default;

const saved = { ...process.env };
let root: string;
beforeEach(() => {
	// Only the test's own spaces folder, agent home and config: none of the user's.
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-spaces-wiring-")));
	for (const name of ["PI_SPACES_BASE_HOME", "PI_SPACES_CONFIG", "PI_SPACE", "PI_SPACE_HOME", "PI_SPACES_COMMAND"]) delete process.env[name];
	Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, ".config"), PI_SPACES_DIR: join(root, "spaces") });
	createSpace(join(root, "spaces"), "work", "npm:@jals1212/pi-spaces");
	process.env.PI_CODING_AGENT_DIR = join(root, "spaces", "work", "agent");
});
afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A session of the extension with a stand-in Pi: start() and shutdown() run its handlers. */
function openSession() {
	const handlers: Record<string, Handler> = {};
	const statuses: (string | undefined)[] = [];
	extension({
		on: (name: string, fn: Handler) => (handlers[name] = fn),
		registerFlag: () => {},
		registerCommand: () => {},
	} as never);
	const ctx = { hasUI: true, ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text), notify: () => {} } };
	return {
		statuses,
		start: () => handlers.session_start({ reason: "startup" }, ctx),
		shutdown: () => handlers.session_shutdown({}, ctx),
	};
}

/** A fake `hc` first on PATH: `labels()` lists each call as `arg|arg|...|`. */
function fakeHc() {
	const dir = mkdtempSync(join(root, "hc-"));
	const log = join(dir, "log");
	writeFileSync(join(dir, "hc"), `#!/bin/sh\nprintf '%s|' "$@" >> '${log}'\necho >> '${log}'\n`);
	chmodSync(join(dir, "hc"), 0o755);
	process.env.PATH = `${dir}:${process.env.PATH}`;
	return () => {
		try {
			return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};
}

/** A fake Herdr socket: records each report's params and answers ok, after `delay()` when given. */
async function fakeHerdr(delay?: (params: { tokens: Record<string, unknown> }) => Promise<void>) {
	// A named pipe on Windows, where a socket cannot be a file.
	const socket = process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}` : join(root, "herdr.sock");
	const reports: { pane_id: string; source: string; tokens: Record<string, unknown>; ttl_ms?: number }[] = [];
	const server = createServer((conn) => {
		conn.on("data", async (data) => {
			for (const line of String(data).split("\n").filter(Boolean)) {
				const request = JSON.parse(line);
				reports.push(request.params);
				await delay?.(request.params);
				conn.write(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	return { socket, reports, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// The fake hc is a sh script, and herdr-core (hc) runs on macOS and Linux only.
const HC = { skip: process.platform === "win32" ? "herdr-core (hc) runs on macOS and Linux only" : false };

async function until(check: () => boolean, what: () => unknown) {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(check(), JSON.stringify(what()));
}

test("in a Herdr pane, the status line is the pane's space token while the session lasts, and the session clears it", async () => {
	const herdr = await fakeHerdr();
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: herdr.socket });
	try {
		const session = openSession();
		await session.start();
		assert.deepEqual(session.statuses, ["🪐 pi/work"]);
		await until(() => herdr.reports.length === 1, () => herdr.reports);
		assert.deepEqual(herdr.reports[0], { pane_id: "w1:p1", source: "pi-spaces", tokens: { space: "🪐 pi/work" }, ttl_ms: 30_000 });
		await session.shutdown();
		assert.deepEqual(herdr.reports.at(-1), { pane_id: "w1:p1", source: "pi-spaces", tokens: { space: null } });
	} finally {
		await herdr.close();
	}
});

test("in a herdr-app terminal, the status line is the terminal's space label, and the session removes it", HC, async () => {
	const labels = fakeHc();
	process.env.HC_TERMINAL_ID = "t7";
	const session = openSession();
	await session.start();
	await until(() => labels().length === 1, labels);
	assert.equal(labels()[0], "label|t7|space=🪐 pi/work|");
	await session.shutdown();
	assert.deepEqual(labels(), ["label|t7|space=🪐 pi/work|", "label|t7|space=|"]);
});

test("the herdr-app space label is set once while the terminal and the space stay the same: a label has no TTL", HC, async () => {
	const labels = fakeHc();
	process.env.HC_TERMINAL_ID = "t7";
	const session = openSession();
	await session.start();
	await session.start(); // a new session or a reload in the same process
	await until(() => labels().length >= 1, labels);
	// Time for a second hc call, were one made.
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(labels(), ["label|t7|space=🪐 pi/work|"]);
	await session.shutdown();
	assert.deepEqual(labels().slice(1), ["label|t7|space=|"]);
});

test("a session that starts in another herdr-app terminal first removes the space label of the terminal it leaves", HC, async () => {
	const labels = fakeHc();
	process.env.HC_TERMINAL_ID = "t7";
	const session = openSession();
	await session.start();
	process.env.HC_TERMINAL_ID = "t8";
	await session.start();
	await until(() => labels().some((line) => line.startsWith("label|t8|")), labels);
	assert.deepEqual(labels(), ["label|t7|space=🪐 pi/work|", "label|t7|space=|", "label|t8|space=🪐 pi/work|"]);
	await session.shutdown();
	assert.equal(labels().at(-1), "label|t8|space=|");
});

test("session_shutdown clears the Herdr token and the herdr-app label together, not one after the other", HC, async () => {
	const labels = fakeHc();
	// The answer to the token's clear waits (up to 1 s, within herdrSend's 2 s) for the label's removal: it comes
	// only if both were sent at once.
	let labelRemovedFirst: boolean | undefined;
	const herdr = await fakeHerdr(async (params) => {
		if (params.tokens.space !== null) return;
		for (let i = 0; i < 200 && !labels().includes("label|t7|space=|"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
		labelRemovedFirst = labels().includes("label|t7|space=|");
	});
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: herdr.socket, HC_TERMINAL_ID: "t7" });
	try {
		const session = openSession();
		await session.start();
		await until(() => herdr.reports.length === 1 && labels().length === 1, () => ({ reports: herdr.reports, labels: labels() }));
		await session.shutdown();
		assert.deepEqual(herdr.reports.at(-1)?.tokens, { space: null });
		assert.equal(labels().at(-1), "label|t7|space=|");
		assert.equal(labelRemovedFirst, true);
	} finally {
		await herdr.close();
	}
});

test("with no space to show (the base home, started plainly), neither Herdr nor herdr-app gets anything", async () => {
	const labels = fakeHc();
	const herdr = await fakeHerdr();
	mkdirSync(join(root, "agent"));
	Object.assign(process.env, { PI_CODING_AGENT_DIR: join(root, "agent"), HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: herdr.socket, HC_TERMINAL_ID: "t7" });
	try {
		const session = openSession();
		await session.start();
		assert.deepEqual(session.statuses, [undefined]);
		await session.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(herdr.reports, []);
		assert.deepEqual(labels(), []);
	} finally {
		await herdr.close();
	}
});
