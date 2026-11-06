import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { HERDR_TTL_MS, hcEventLabels, hcLabel, hcLabelArgs, keepHcLabel, herdrAppTerminal, herdrPane, herdrReport, herdrSend, startHerdrToken } from "../src/herdr.ts";

test("herdrPane reads the pane and socket only inside a Herdr pane", () => {
	assert.deepEqual(herdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: " p1 ", HERDR_SOCKET_PATH: "/s.sock" }), { pane: "p1", socket: "/s.sock" });
	assert.equal(herdrPane({ HERDR_PANE_ID: "p1", HERDR_SOCKET_PATH: "/s.sock" }), null);
	assert.equal(herdrPane({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s.sock" }), null);
	assert.equal(herdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: "p1" }), null);
});

test("herdrReport sets the space token with a TTL, or clears it", () => {
	assert.deepEqual(herdrReport("p1", "🪐 pi/work"), {
		method: "pane.report_metadata",
		params: { pane_id: "p1", source: "pi-spaces", tokens: { space: "🪐 pi/work" }, ttl_ms: HERDR_TTL_MS },
	});
	assert.deepEqual(herdrReport("p1", null), {
		method: "pane.report_metadata",
		params: { pane_id: "p1", source: "pi-spaces", tokens: { space: null } },
	});
});

/** A socket path in `dir`: a named pipe on Windows, where a socket cannot be a file. */
function socketPath(dir: string) {
	return process.platform === "win32" ? `\\\\.\\pipe\\${basename(dir)}` : join(dir, "herdr.sock");
}

// A fake Herdr socket: records each request and answers ok (or an error).
async function fakeHerdr(answer: "ok" | "error" = "ok") {
	const socket = socketPath(mkdtempSync(join(tmpdir(), "pi-spaces-herdr-")));
	const requests: { id: string; method: string; params: Record<string, unknown> }[] = [];
	const server = createServer((conn) => {
		let data = "";
		conn.on("data", (chunk) => {
			data += chunk;
			const end = data.indexOf("\n");
			if (end < 0) return;
			const request = JSON.parse(data.slice(0, end));
			requests.push(request);
			const result = answer === "ok" ? { type: "ok" } : { type: "error" };
			conn.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	return { socket, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("herdrSend resolves true when Herdr accepts the report, false otherwise", async () => {
	const herdr = await fakeHerdr();
	assert.equal(await herdrSend({ pane: "p1", socket: herdr.socket })("🪐 pi/work"), true);
	assert.equal(herdr.requests.length, 1);
	assert.equal(herdr.requests[0].method, "pane.report_metadata");
	assert.deepEqual(herdr.requests[0].params, herdrReport("p1", "🪐 pi/work").params);
	await herdr.close();

	const refusing = await fakeHerdr("error");
	assert.equal(await herdrSend({ pane: "p1", socket: refusing.socket })("x"), false);
	await refusing.close();

	assert.equal(await herdrSend({ pane: "p1", socket: socketPath(join(tmpdir(), "no-such-herdr")) })("x"), false);
});

test("startHerdrToken reports the value, again every refresh, and clears it on stop", async () => {
	const sent: (string | null)[] = [];
	const token = startHerdrToken("🪐 pi/work", { send: async (v) => void sent.push(v) || true, refreshMs: 20 });
	await new Promise((resolve) => setTimeout(resolve, 70));
	await token.stop();
	assert.equal(sent[0], "🪐 pi/work");
	assert.ok(sent.filter((v) => v === "🪐 pi/work").length >= 2, `refreshed: ${JSON.stringify(sent)}`);
	assert.equal(sent.at(-1), null);
	const count = sent.length;
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(sent.length, count, "nothing is sent after stop");
});

test("startHerdrToken sends one report at a time", async () => {
	let inFlight = 0;
	let most = 0;
	const send = async () => {
		most = Math.max(most, ++inFlight);
		await new Promise((resolve) => setTimeout(resolve, 30));
		inFlight--;
		return true;
	};
	const token = startHerdrToken("x", { send, refreshMs: 5 });
	await new Promise((resolve) => setTimeout(resolve, 60));
	await token.stop();
	assert.equal(most, 1);
});

test("herdrAppTerminal reads the herdr-app terminal, or null outside one", () => {
	assert.equal(herdrAppTerminal({ HC_TERMINAL_ID: " t6 " }), "t6");
	assert.equal(herdrAppTerminal({ HC_TERMINAL_ID: "" }), null);
	assert.equal(herdrAppTerminal({}), null);
});

test("hcLabelArgs sets the space label, or removes it (null)", () => {
	assert.deepEqual(hcLabelArgs("t6", "🪐 pi/work"), ["label", "t6", "space=🪐 pi/work"]);
	assert.deepEqual(hcLabelArgs("t6", null), ["label", "t6", "space="]);
});

test("hcLabel runs hc with those arguments, never throws, and tells whether it worked", async () => {
	const calls: string[][] = [];
	assert.equal(await hcLabel("t6", "🪐 pi/work", async (args) => void calls.push(args)), true);
	assert.equal(
		await hcLabel("t6", null, async () => {
			throw new Error("no hc");
		}),
		false,
	);
	assert.deepEqual(calls, [["label", "t6", "space=🪐 pi/work"]]);
});

test("hcEventLabels reads the terminal's labels from an hc events snapshot or labels event, and nothing else", () => {
	const snapshot = JSON.stringify({ channel: null, seq: 1, terminals: [{ address: "t5", labels: {} }, { address: "t6", labels: { space: "🪐 pi/work", where: "x" } }] });
	assert.deepEqual(hcEventLabels(snapshot, "t6"), { space: "🪐 pi/work", where: "x" });
	const event = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { data: { labels: { where: "x" } }, seq: 2, terminal: "t6", type: "labels" } });
	assert.deepEqual(hcEventLabels(event, "t6"), { where: "x" });
	assert.equal(hcEventLabels(event, "t5"), undefined);
	assert.equal(hcEventLabels(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { data: {}, terminal: "t6", type: "status" } }), "t6"), undefined);
	assert.equal(hcEventLabels(JSON.stringify({ terminals: [{ address: "t5", labels: {} }] }), "t6"), undefined);
	assert.equal(hcEventLabels("not json", "t6"), undefined);
});

/** A stand-in for `hc events`: each start is a stream the test feeds (`emit`) and ends (`end`). */
function fakeEvents() {
	const streams: { terminal: string; emit: (labels: Record<string, string>) => void; end: () => void; stopped: boolean }[] = [];
	const events = (terminal: string, onLine: (line: string) => void) => {
		let end!: () => void;
		const done = new Promise<void>((resolve) => (end = resolve));
		const stream = {
			terminal,
			emit: (labels: Record<string, string>) => onLine(JSON.stringify({ terminals: [{ address: terminal, labels }] })),
			end,
			stopped: false,
		};
		streams.push(stream);
		return { done, stop: () => ((stream.stopped = true), end()) };
	};
	return { streams, events };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("keepHcLabel sets the label, and sets it again whenever hc events shows it missing or changed", async () => {
	const calls: string[][] = [];
	const { streams, events } = fakeEvents();
	const keeper = keepHcLabel("t6", "🪐 pi/work", { run: async (args) => void calls.push(args), events });
	await tick();
	assert.deepEqual(calls, [["label", "t6", "space=🪐 pi/work"]]);
	assert.deepEqual(streams.map((s) => s.terminal), ["t6"]);
	streams[0].emit({ space: "🪐 pi/work" });
	await tick();
	assert.equal(calls.length, 1);
	streams[0].emit({ where: "x" }); // the label is gone
	await tick();
	streams[0].emit({ space: "🪐 other/space" });
	await tick();
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[2], ["label", "t6", "space=🪐 pi/work"]);
	await keeper.stop();
});

test("keepHcLabel follows hc events again after its stream ends (a restarted core), and the snapshot restores the label", async () => {
	const calls: string[][] = [];
	const { streams, events } = fakeEvents();
	const keeper = keepHcLabel("t6", "🪐 pi/work", { run: async (args) => void calls.push(args), events, retryMs: [5] });
	await tick();
	streams[0].end();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(streams.length, 2);
	streams[1].emit({});
	await tick();
	assert.deepEqual(calls, [
		["label", "t6", "space=🪐 pi/work"],
		["label", "t6", "space=🪐 pi/work"],
	]);
	await keeper.stop();
});

test("keepHcLabel restarts hc events after a failed set, so the next snapshot tries again", async () => {
	let fail = true;
	const calls: string[][] = [];
	const { streams, events } = fakeEvents();
	const keeper = keepHcLabel("t6", "🪐 pi/work", {
		run: async (args) => {
			calls.push(args);
			if (fail) throw new Error("core busy");
		},
		events,
		retryMs: [5],
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(streams[0].stopped, true);
	assert.equal(streams.length, 2);
	fail = false;
	streams[1].emit({});
	await tick();
	assert.equal(calls.length, 2);
	await keeper.stop();
});

test("keepHcLabel.stop ends the stream for good and removes the label after any set on its way", async () => {
	const calls: string[][] = [];
	let release!: () => void;
	const { streams, events } = fakeEvents();
	const keeper = keepHcLabel("t6", "🪐 pi/work", {
		run: async (args) => {
			calls.push(args);
			if (calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
		},
		events,
		retryMs: [5],
	});
	await tick();
	const stopped = keeper.stop();
	await tick();
	assert.equal(calls.length, 1); // the removal waits for the set
	release();
	await stopped;
	assert.deepEqual(calls.at(-1), ["label", "t6", "space="]);
	assert.equal(streams[0].stopped, true);
	streams[0].emit({});
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(streams.length, 1);
	assert.equal(calls.length, 2);
});
