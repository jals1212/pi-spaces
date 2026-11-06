import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HERDR_TTL_MS, hcLabel, hcLabelArgs, herdrAppTerminal, herdrPane, herdrReport, herdrSend, startHerdrToken } from "../src/herdr.ts";

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

// A fake Herdr socket: records each request and answers ok (or an error).
async function fakeHerdr(answer: "ok" | "error" = "ok") {
	const socket = join(mkdtempSync(join(tmpdir(), "pi-spaces-herdr-")), "herdr.sock");
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

	assert.equal(await herdrSend({ pane: "p1", socket: join(tmpdir(), "no-such-herdr.sock") })("x"), false);
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

test("hcLabel runs hc with those arguments and never throws", async () => {
	const calls: string[][] = [];
	await hcLabel("t6", "🪐 pi/work", async (args) => void calls.push(args));
	await hcLabel("t6", null, async () => {
		throw new Error("no hc");
	});
	assert.deepEqual(calls, [["label", "t6", "space=🪐 pi/work"]]);
});
