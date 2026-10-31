import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { initialState, parseKeys, type PickerItem, renderPicker, runPicker, step, visibleItems } from "../src/picker.ts";

const ITEMS: PickerItem[] = [
	{ group: "gentle", name: "base" },
	{ group: "gentle", name: "contigo", active: true },
	{ group: "gentle", name: "work" },
	{ group: "pi", name: "base" },
	{ group: "pi", name: "lab" },
];

test("parseKeys: arrows, Enter, Esc, Ctrl-C, Ctrl-D, Backspace, Ctrl-U, Ctrl-P/N, Tab and text, several in one chunk", () => {
	assert.deepEqual(parseKeys("\x1b[A\x1bOB\r\n"), [{ kind: "up" }, { kind: "down" }, { kind: "enter" }, { kind: "enter" }]);
	assert.deepEqual(parseKeys("\x1b"), [{ kind: "escape" }]);
	assert.deepEqual(parseKeys("\x1b\x1b"), [{ kind: "escape" }, { kind: "escape" }]);
	assert.deepEqual(parseKeys("\x03\x04"), [{ kind: "interrupt" }, { kind: "escape" }]);
	assert.deepEqual(parseKeys("\x7f\b\x15"), [{ kind: "backspace" }, { kind: "backspace" }, { kind: "clear" }]);
	assert.deepEqual(parseKeys("\x10\x0e\t"), [{ kind: "up" }, { kind: "down" }, { kind: "down" }]);
	assert.deepEqual(parseKeys("wo ñ"), [{ kind: "text", text: "w" }, { kind: "text", text: "o" }, { kind: "text", text: " " }, { kind: "text", text: "ñ" }]);
	// Other escape sequences (Home, F1, Delete) are skipped whole; other control characters are ignored.
	assert.deepEqual(parseKeys("\x1b[H\x1b[3~\x1bOPa\x01"), [{ kind: "text", text: "a" }]);
});

test("initialState puts the cursor on the active item, else the first", () => {
	assert.equal(visibleItems(initialState(ITEMS))[initialState(ITEMS).cursor].name, "contigo");
	assert.equal(initialState(ITEMS.map(({ active, ...item }) => item)).cursor, 0);
});

test("step: up and down move and wrap around; Enter picks the item under the cursor", () => {
	let state = initialState(ITEMS);
	state = (step(state, { kind: "down" }) as { state: typeof state }).state;
	assert.equal(state.cursor, 2);
	state = (step(state, { kind: "up" }) as { state: typeof state }).state;
	state = (step(state, { kind: "up" }) as { state: typeof state }).state;
	state = (step(state, { kind: "up" }) as { state: typeof state }).state;
	assert.equal(state.cursor, 4);
	state = (step(state, { kind: "down" }) as { state: typeof state }).state;
	assert.equal(state.cursor, 0);
	assert.deepEqual(step(state, { kind: "enter" }), { done: ITEMS[0] });
});

test("step: Esc cancels, Ctrl-C interrupts", () => {
	assert.deepEqual(step(initialState(ITEMS), { kind: "escape" }), { done: undefined });
	assert.deepEqual(step(initialState(ITEMS), { kind: "interrupt" }), { done: undefined, interrupted: true });
});

test("step: typing filters by space or group name, case-insensitive; the cursor goes to the first match; Backspace and Ctrl-U widen it", () => {
	const type = (state: ReturnType<typeof initialState>, text: string) => [...text].reduce((current, char) => (step(current, { kind: "text", text: char }) as { state: typeof current }).state, state);
	let state = type(initialState(ITEMS), "WO");
	assert.equal(state.query, "WO");
	assert.deepEqual(visibleItems(state), [ITEMS[2]]);
	assert.equal(state.cursor, 0);
	state = type(initialState(ITEMS), "pi");
	assert.deepEqual(visibleItems(state), [ITEMS[3], ITEMS[4]]);
	state = (step(type(initialState(ITEMS), "lax"), { kind: "backspace" }) as { state: typeof state }).state;
	assert.equal(state.query, "la");
	assert.deepEqual(visibleItems(state), [ITEMS[4]]);
	state = (step(state, { kind: "clear" }) as { state: typeof state }).state;
	assert.equal(visibleItems(state).length, ITEMS.length);
});

test("step: Enter with nothing matching does nothing; arrows do nothing either", () => {
	const empty = (step(initialState(ITEMS), { kind: "text", text: "z" }) as { state: ReturnType<typeof initialState> }).state;
	assert.deepEqual(visibleItems(empty), []);
	assert.deepEqual(step(empty, { kind: "enter" }), { state: empty });
	assert.deepEqual(step(empty, { kind: "down" }), { state: empty });
});

test("renderPicker: a hint, the filter, a header per group, the cursor and the active mark", () => {
	assert.deepEqual(renderPicker(initialState(ITEMS), 24), [
		"Pick a space: ↑/↓ move, Enter starts Pi, Esc cancels, type to filter",
		"> ",
		"gentle",
		"    base",
		"  > contigo (active)",
		"    work",
		"pi",
		"    base",
		"    lab",
	]);
});

test("renderPicker: no headers without groups; a filter with no match says so", () => {
	const plain = [{ name: "base" }, { name: "work" }];
	assert.deepEqual(renderPicker(initialState(plain), 24).slice(1), ["> ", "  > base", "    work"]);
	const none = (step(initialState(plain), { kind: "text", text: "z" }) as { state: ReturnType<typeof initialState> }).state;
	assert.deepEqual(renderPicker(none, 24).slice(1), ["> z", "  No space matches."]);
});

test("renderPicker: a long list shows a window around the cursor that fits the terminal, with more above and below", () => {
	const many = Array.from({ length: 30 }, (_, index) => ({ name: `s${String(index).padStart(2, "0")}` }));
	let state = initialState(many);
	for (let index = 0; index < 20; index++) state = (step(state, { kind: "down" }) as { state: typeof state }).state;
	const lines = renderPicker(state, 10);
	assert.ok(lines.length <= 9, String(lines.length));
	assert.ok(lines.includes("  > s20"));
	assert.match(lines[2], /more above/);
	assert.match(lines.at(-1) as string, /more below/);
});

/** A terminal for runPicker: keys written in, what it draws read out, raw mode recorded. */
function terminal(chunks: string[], columns?: number) {
	const stdin = Object.assign(new PassThrough({ encoding: "utf8" }), { isTTY: true, raw: [] as boolean[], setRawMode(mode: boolean) { this.raw.push(mode); return this; } });
	let out = "";
	const stdout = { rows: 24, columns, write: (text: string) => void (out += text) };
	// Each chunk on its own tick, the way a terminal sends key presses.
	queueMicrotask(async () => {
		for (const chunk of chunks) {
			await new Promise((resolve) => setImmediate(resolve));
			stdin.write(chunk);
		}
	});
	return { stdin, stdout, out: () => out };
}

test("runPicker: raw mode on, then off; the picker is erased before it returns the chosen item", async () => {
	const term = terminal(["\x1b[B", "\r"]);
	const result = await runPicker(ITEMS, term);
	assert.deepEqual(result, { item: ITEMS[2], interrupted: false });
	assert.deepEqual(term.stdin.raw, [true, false]);
	assert.match(term.out(), /> contigo \(active\)/);
	assert.match(term.out(), /> work/);
	// Hidden cursor while it runs, shown again, and the last frame cleared.
	assert.ok(term.out().startsWith("\x1b[?25l"));
	assert.ok(term.out().endsWith("\x1b[J\x1b[?25h"));
	assert.equal(term.stdin.listenerCount("data"), 0);
});

test("runPicker: typing filters and Enter picks the match; Esc and Ctrl-C give nothing; the end of input cancels", async () => {
	assert.deepEqual(await runPicker(ITEMS, terminal(["l", "a", "\r"])), { item: ITEMS[4], interrupted: false });
	assert.deepEqual(await runPicker(ITEMS, terminal(["\x1b"])), { item: undefined, interrupted: false });
	assert.deepEqual(await runPicker(ITEMS, terminal(["\x03"])), { item: undefined, interrupted: true });
	const ended = terminal([]);
	queueMicrotask(() => setImmediate(() => ended.stdin.end()));
	assert.deepEqual(await runPicker(ITEMS, ended), { item: undefined, interrupted: false });
});

test("renderPicker: every line is cut to the terminal width by code points, ending with an ellipsis", () => {
	const wide = [{ name: "a-very-long-space-name-ñññ", active: true }, { name: "short" }];
	const lines = renderPicker(initialState(wide), 24, 12);
	assert.ok(lines.every((line) => [...line].length <= 12), JSON.stringify(lines));
	assert.deepEqual(lines.slice(1), ["> ", "  > a-very-…", "    short"]);
	// Wide enough, nothing changes; the default width is 80.
	assert.deepEqual(renderPicker(initialState(wide), 24, 80), renderPicker(initialState(wide), 24));
});

test("runPicker: frames are drawn at the terminal width", async () => {
	const term = terminal(["\r"], 10);
	await runPicker([{ name: "abcdefghijklmnop" }], term);
	assert.match(term.out(), /  > abcde…/);
	assert.doesNotMatch(term.out(), /abcdef/);
});

test("runPicker: an escape sequence split across chunks is not taken as Esc", async () => {
	assert.deepEqual(await runPicker(ITEMS, terminal(["\x1b", "[B", "\r"])), { item: ITEMS[2], interrupted: false });
});

test("runPicker: a lone ESC cancels once the wait runs out; the picker stops listening", async () => {
	const term = terminal(["\x1b"]);
	assert.deepEqual(await runPicker(ITEMS, term, 10), { item: undefined, interrupted: false });
	assert.deepEqual(term.stdin.raw, [true, false]);
	assert.equal(term.stdin.listenerCount("data"), 0);
});

test("runPicker: a throw while drawing restores the terminal and rejects with the error", async () => {
	const term = terminal(["\x1b[B", "\r"]);
	let writes = 0;
	const boom = new Error("boom");
	// The hide-cursor write and the first frame work; every write after that throws, even the ones that restore.
	term.stdout.write = (text: string) => {
		writes += 1;
		if (writes > 2) throw boom;
		return text;
	};
	const exits = process.listenerCount("exit");
	const running = runPicker(ITEMS, term);
	assert.equal(process.listenerCount("exit"), exits + 1);
	await assert.rejects(running, boom);
	assert.deepEqual(term.stdin.raw, [true, false]);
	assert.equal(term.stdin.listenerCount("data"), 0);
	assert.equal(process.listenerCount("exit"), exits);
});

test("runPicker: if the process exits while it runs, raw mode is turned off and the cursor shown", async () => {
	const term = terminal([]);
	const running = runPicker(ITEMS, term);
	const [onExit] = process.listeners("exit").slice(-1) as [() => void];
	onExit();
	assert.deepEqual(term.stdin.raw, [true, false]);
	assert.ok(term.out().endsWith("\x1b[?25h"));
	term.stdin.end();
	await running;
});
