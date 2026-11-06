// Herdr (https://herdr.dev): in a pane Herdr runs, the status line text (`🪐 <profile>/<name>`) is also the pane's
// `$space` metadata token, so a `["$space"]` row in Herdr's Agents sidebar (or a herdr-app mod reading the
// terminal's `space` label) shows the space next to the agent. Display only: it never touches the agent's state.
// The same protocol as @jals1212/ci-local-pi's `$ci` token.
import { execFile, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

type Env = Record<string, string | undefined>;

/** The token's name, as a sidebar row names it: `$space`. */
export const HERDR_TOKEN = "space";
/** Who reports the token. */
export const HERDR_SOURCE = "pi-spaces";
/** Herdr drops the token this long after the last report: a Pi gone leaves nothing behind. */
export const HERDR_TTL_MS = 30_000;
/** The token is reported again this often, well inside its TTL. */
export const HERDR_REFRESH_MS = 10_000;

export type HerdrPane = { pane: string; socket: string };
export type HerdrSend = (value: string | null) => Promise<boolean>;

/** The pane and socket of the Herdr pane this process runs in, or null outside one. */
export function herdrPane(env: Env): HerdrPane | null {
	const pane = env.HERDR_PANE_ID?.trim();
	const socket = env.HERDR_SOCKET_PATH?.trim();
	return env.HERDR_ENV === "1" && pane && socket ? { pane, socket } : null;
}

/** The socket request that sets the token (with its TTL), or clears it (null). */
export function herdrReport(pane: string, value: string | null) {
	const params: Record<string, unknown> = { pane_id: pane, source: HERDR_SOURCE, tokens: { [HERDR_TOKEN]: value } };
	if (value !== null) params.ttl_ms = HERDR_TTL_MS;
	return { method: "pane.report_metadata", params };
}

let requests = 0;

/**
 * A sender of the token to Herdr's socket (one JSON line, one reply): resolves true when Herdr accepted it,
 * false on any error or after `timeoutMs`.
 */
export function herdrSend({ pane, socket }: HerdrPane, { timeoutMs = 2000 } = {}): HerdrSend {
	return (value) =>
		new Promise((resolve) => {
			const id = `pi-spaces-${process.pid}-${++requests}`;
			let reply = "";
			let done = false;
			const conn = createConnection(socket);
			const finish = (ok: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				conn.destroy();
				resolve(ok);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			timer.unref?.();
			conn.on("connect", () => conn.write(`${JSON.stringify({ id, ...herdrReport(pane, value) })}\n`));
			conn.on("data", (data) => {
				reply += data;
				const end = reply.indexOf("\n");
				if (end < 0) return;
				try {
					const answer = JSON.parse(reply.slice(0, end));
					finish(answer.id === id && answer.result?.type === "ok");
				} catch {
					finish(false);
				}
			});
			conn.on("error", () => finish(false));
			conn.on("close", () => finish(false));
		});
}

/**
 * Reports `value` now and again every `refreshMs`, one report at a time (a refresh due while one is on its way is
 * skipped). `stop()` ends the refreshes, clears the token and resolves once that report is done.
 */
export function startHerdrToken(value: string, { send, refreshMs = HERDR_REFRESH_MS }: { send: HerdrSend; refreshMs?: number }) {
	let inFlight: Promise<unknown> | null = null;
	let stopped = false;
	const report = () => {
		if (stopped || inFlight) return;
		inFlight = send(value)
			.catch(() => false)
			.finally(() => {
				inFlight = null;
			});
	};
	report();
	const timer = setInterval(report, refreshMs);
	timer.unref?.();
	return {
		async stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			await inFlight;
			await send(null).catch(() => false);
		},
	};
}

// herdr-app (Herdr's window app) shows no pane metadata: its Agents sidebar reads the terminal's labels, which its
// terminals' programs set with `hc label` (`HC_TERMINAL_ID` names the terminal). A label has no TTL, so the session
// removes it when it ends. A label can also go while the session lasts (a set that failed while the core started,
// a core restarted when herdr-app closed and opened): the session follows `hc events` and sets it again.

/** The label's name; an Agents sidebar mod reads it as `labels.space`. */
export const HC_LABEL = "space";

/** The herdr-app terminal this process runs in, or null outside one. */
export function herdrAppTerminal(env: Env): string | null {
	return env.HC_TERMINAL_ID?.trim() || null;
}

/** The `hc` arguments that set the label, or remove it (null). */
export function hcLabelArgs(terminal: string, value: string | null): string[] {
	return ["label", terminal, `${HC_LABEL}=${value ?? ""}`];
}

export type HcRun = (args: string[]) => Promise<unknown>;

/** Runs `hc` (on PATH) with `args`, rejecting on failure or after `timeoutMs`. */
export const runHc: HcRun = (args, timeoutMs = 2000) =>
	new Promise((resolve, reject) => {
		execFile("hc", args, { timeout: timeoutMs, windowsHide: true }, (error) => (error ? reject(error) : resolve(undefined)));
	});

/** Sets the label (null removes it), resolving whether it worked. Display only: a failure (no `hc`, no core) never throws. */
export async function hcLabel(terminal: string, value: string | null, run: HcRun = runHc): Promise<boolean> {
	try {
		await run(hcLabelArgs(terminal, value));
		return true;
	} catch {
		return false;
	}
}

/** The labels of `terminal` in one `hc events --json` line (its first snapshot, or a `labels` event), or undefined. */
export function hcEventLabels(line: string, terminal: string): Record<string, string> | undefined {
	let message: any;
	try {
		message = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (Array.isArray(message?.terminals)) return message.terminals.find((t: any) => t?.address === terminal)?.labels ?? undefined;
	const event = message?.params;
	return event?.terminal === terminal && event.type === "labels" ? (event.data?.labels ?? undefined) : undefined;
}

/** A stream of `hc events` lines for one terminal: `done` resolves when it ends, `stop()` ends it. */
export type HcEvents = (terminal: string, onLine: (line: string) => void) => { done: Promise<void>; stop: () => void };

/** Runs `hc events --terminal <terminal> --json` (on PATH). It never keeps Pi from exiting. */
export const spawnHcEvents: HcEvents = (terminal, onLine) => {
	const child = spawn("hc", ["events", "--terminal", terminal, "--json"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	const done = new Promise<void>((resolve) => {
		child.on("close", () => resolve());
		child.on("error", () => resolve());
	});
	createInterface({ input: child.stdout }).on("line", onLine);
	child.unref();
	(child.stdout as unknown as { unref?: () => void }).unref?.();
	return { done, stop: () => void child.kill() };
};

/** How long to wait before following `hc events` again, by attempt: an ended stream is a core gone for a while. */
export const HC_EVENTS_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * Sets the label, then follows `hc events` for the terminal and sets it again whenever it is missing or changed;
 * when the stream ends (the core restarted) or a set fails, follows it again after `retryMs`, and its first
 * snapshot restores the label. `stop()` ends it and removes the label once any set on its way is done.
 */
export function keepHcLabel(
	terminal: string,
	value: string,
	{ run = runHc, events = spawnHcEvents, retryMs = HC_EVENTS_RETRY_MS }: { run?: HcRun; events?: HcEvents; retryMs?: number[] } = {},
) {
	let stopped = false;
	let setting: Promise<unknown> | null = null;
	let stream: ReturnType<HcEvents> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempt = 0;
	const set = () => {
		if (stopped || setting) return;
		setting = hcLabel(terminal, value, run).then((ok) => {
			setting = null;
			if (!ok) stream?.stop(); // its restart brings a snapshot, and the next try
		});
	};
	const follow = () => {
		if (stopped) return;
		const current = events(terminal, (line) => {
			const labels = hcEventLabels(line, terminal);
			if (!labels || current !== stream) return;
			attempt = 0;
			if (labels[HC_LABEL] !== value) set();
		});
		stream = current;
		current.done.then(() => {
			if (stopped || current !== stream) return;
			stream = undefined;
			timer = setTimeout(follow, retryMs[Math.min(attempt++, retryMs.length - 1)]);
			timer.unref?.();
		});
	};
	set();
	follow();
	return {
		async stop() {
			if (stopped) return;
			stopped = true;
			clearTimeout(timer);
			stream?.stop();
			stream = undefined;
			await setting;
			await hcLabel(terminal, null, run);
		},
	};
}
