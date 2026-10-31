// The interactive picker of a bare `pi-space`: arrows move, Enter picks, Esc cancels, typing filters.
// No dependency: the terminal goes into raw mode and the keys are read from the bytes it sends.

/** One choice: a space name (or base) in an optional group, a profile's name. */
export interface PickerItem {
	group?: string;
	name: string;
	/** The space this Pi runs in; the cursor starts on it. */
	active?: boolean;
}

export type Key =
	| { kind: "up" | "down" | "enter" | "escape" | "interrupt" | "backspace" | "clear" }
	| { kind: "text"; text: string };

export interface PickerState {
	items: PickerItem[];
	query: string;
	/** An index into visibleItems. */
	cursor: number;
}

/** What one key leads to: the next state, or the end with the chosen item (none when cancelled). */
export type Step = { state: PickerState } | { done: PickerItem | undefined; interrupted?: true };

const CONTROL_KEYS: Record<string, Key> = {
	"\r": { kind: "enter" },
	"\n": { kind: "enter" },
	"\x03": { kind: "interrupt" },
	// Ctrl-D, like the end of input, cancels.
	"\x04": { kind: "escape" },
	"\x7f": { kind: "backspace" },
	"\b": { kind: "backspace" },
	"\x15": { kind: "clear" },
	"\x10": { kind: "up" },
	"\x0e": { kind: "down" },
	"\t": { kind: "down" },
};

const ARROWS: Record<string, Key> = { A: { kind: "up" }, B: { kind: "down" } };

/**
 * The keys in one chunk of terminal input. ESC [ or ESC O start a sequence: up and down are kept, any other
 * (Home, Delete, F1) is skipped whole. An ESC followed by nothing or by another ESC is the Esc key.
 */
export function parseKeys(chunk: string): Key[] {
	const keys: Key[] = [];
	const chars = [...chunk];
	let index = 0;
	while (index < chars.length) {
		const char = chars[index];
		if (char === "\x1b") {
			const next = chars[index + 1];
			if (next !== "[" && next !== "O") {
				keys.push({ kind: "escape" });
				index += 1;
				continue;
			}
			// Parameters, then one final byte from "@" to "~"; ESC O takes just the one byte after it.
			let end = index + 2;
			if (next === "[") while (end < chars.length && !/[@-~]/.test(chars[end])) end += 1;
			const final = chars[end];
			if (final !== undefined && end === index + 2 && Object.hasOwn(ARROWS, final)) keys.push(ARROWS[final]);
			index = end + 1;
			continue;
		}
		if (Object.hasOwn(CONTROL_KEYS, char)) keys.push(CONTROL_KEYS[char]);
		else if (char >= " ") keys.push({ kind: "text", text: char });
		index += 1;
	}
	return keys;
}

/**
 * A chunk split into what is complete and the incomplete escape sequence at its end (empty when none): a lone
 * ESC, ESC O, or ESC [ with parameter and intermediate bytes but no final byte yet. A terminal may send the
 * rest of such a sequence in the next chunk.
 */
export function splitIncomplete(chunk: string): [complete: string, tail: string] {
	const start = chunk.lastIndexOf("\x1b");
	if (start === -1) return [chunk, ""];
	const tail = chunk.slice(start);
	const incomplete = tail === "\x1b" || tail === "\x1bO" || (tail.startsWith("\x1b[") && /^[\x20-\x3f]*$/.test(tail.slice(2)));
	return incomplete ? [chunk.slice(0, start), tail] : [chunk, ""];
}

/** The items whose name or group holds the query, case-insensitive, in order. */
export function visibleItems(state: PickerState): PickerItem[] {
	const query = state.query.toLowerCase();
	if (query === "") return state.items;
	return state.items.filter((item) => item.name.toLowerCase().includes(query) || (item.group?.toLowerCase().includes(query) ?? false));
}

/** No filter, the cursor on the active item, else on the first. */
export function initialState(items: PickerItem[]): PickerState {
	return { items, query: "", cursor: Math.max(0, items.findIndex((item) => item.active)) };
}

/** A new query puts the cursor on the first match. */
function withQuery(state: PickerState, query: string): PickerState {
	return { ...state, query, cursor: 0 };
}

export function step(state: PickerState, key: Key): Step {
	const count = visibleItems(state).length;
	switch (key.kind) {
		case "escape":
			return { done: undefined };
		case "interrupt":
			return { done: undefined, interrupted: true };
		case "enter":
			return count === 0 ? { state } : { done: visibleItems(state)[state.cursor] };
		case "up":
		case "down":
			if (count === 0) return { state };
			return { state: { ...state, cursor: (state.cursor + (key.kind === "up" ? count - 1 : 1)) % count } };
		case "backspace":
			return { state: withQuery(state, [...state.query].slice(0, -1).join("")) };
		case "clear":
			return { state: withQuery(state, "") };
		case "text":
			return { state: withQuery(state, state.query + key.text) };
	}
}

const HINT = "Pick a space: ↑/↓ move, Enter starts Pi, Esc cancels, type to filter";

/** The terminal columns of one character: 0 for combining marks and joiners, 2 for East Asian wide ones and emoji, else 1. */
function charWidth(char: string): number {
	const code = char.codePointAt(0) as number;
	if ((code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f) || /^[\p{Mn}\p{Me}]$/u.test(char)) return 0;
	const wide =
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd);
	return wide ? 2 : 1;
}

/** The columns a text takes on a terminal. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char);
	return width;
}

/** The line cut to `columns` terminal columns, ending with "…" when it was longer, so it never wraps. */
function fit(line: string, columns: number): string {
	if (displayWidth(line) <= columns) return line;
	// Keep one column for the "…" (none when there is room for just one); a wide character is never cut in half.
	const room = columns <= 1 ? Math.max(0, columns) : columns - 1;
	let kept = "";
	let width = 0;
	for (const char of line) {
		if (width + charWidth(char) > room) break;
		kept += char;
		width += charWidth(char);
	}
	return columns <= 1 ? kept : `${kept}…`;
}

/**
 * The lines of one frame: the hint, the filter, then the items under a header per group (when they have
 * groups), with the cursor and the active mark. Only a window around the cursor is drawn when the list is
 * longer than the terminal (`rows` lines), with a line that says how many more are above and below. Every
 * line is cut to `columns` so that one line is one terminal row, which the redraw counts on.
 */
export function renderPicker(state: PickerState, rows: number, columns = 80): string[] {
	return frame(state, rows).map((line) => fit(line, columns));
}

function frame(state: PickerState, rows: number): string[] {
	const items = visibleItems(state);
	const head = [HINT, `> ${state.query}`];
	if (items.length === 0) return [...head, "  No space matches."];
	// The body: each item's line, with its group's header before the first of the group; `at` maps the cursor.
	const body: string[] = [];
	let at = 0;
	items.forEach((item, index) => {
		if (item.group !== undefined && item.group !== items[index - 1]?.group) body.push(item.group);
		if (index === state.cursor) at = body.length;
		body.push(`${index === state.cursor ? "  > " : "    "}${item.name}${item.active ? " (active)" : ""}`);
	});
	// Lines the body may use: what the terminal has left after the head, keeping one for the shell prompt (at least 3).
	const room = Math.max(3, rows - head.length - 1);
	if (body.length <= room) return [...head, ...body];
	// Body lines in the window: the room minus the two lines that may say there is more above and below.
	const size = room - 2;
	const start = Math.min(Math.max(0, at - Math.floor(size / 2)), body.length - size);
	const end = start + size;
	const above = start > 0 ? [`  … ${start} more above`] : [];
	const below = end < body.length ? [`  … ${body.length - end} more below`] : [];
	return [...head, ...above, ...body.slice(start, end), ...below];
}

export interface PickerTerminal {
	stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
	stdout: { write(text: string): unknown; rows?: number; columns?: number };
}

/** What runPicker needs of the process: its listeners and the way to raise a signal; the real process by default. */
export interface PickerHost {
	pid: number;
	on(event: string, listener: () => void): unknown;
	once(event: string, listener: () => void): unknown;
	off(event: string, listener: () => void): unknown;
	kill(pid: number, signal: string): unknown;
}

/** The signals that end the picker's process: it restores the terminal, then dies of the same signal. */
const SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"] as const;

/** The chosen item, none when cancelled (Esc, Ctrl-D, the end of input), and whether it was Ctrl-C. */
export interface PickerResult {
	item: PickerItem | undefined;
	interrupted: boolean;
}

/** How long a lone ESC waits for the rest of an escape sequence a terminal may have split across chunks. */
const ESCAPE_WAIT_MS = 50;

/**
 * Runs the picker on a terminal: raw mode while it runs, each frame drawn over the last, and everything put
 * back before it returns (raw mode off, the picker erased, the cursor shown, stdin paused) so Pi can start clean.
 * That also holds when drawing throws (the promise rejects) or the process exits while it runs; on SIGTERM,
 * SIGHUP or SIGINT the terminal is restored and the signal raised again, so the process ends as it would have.
 * A chunk ending in an incomplete escape sequence is held for `escapeWaitMs` to join the next chunk; if none
 * comes, a held lone ESC is the Esc key and any other held sequence is dropped.
 */
export function runPicker(items: PickerItem[], terminal: PickerTerminal, escapeWaitMs = ESCAPE_WAIT_MS, host: PickerHost = process): Promise<PickerResult> {
	const { stdin, stdout } = terminal;
	let state = initialState(items);
	let drawn = 0;
	const render = () => renderPicker(state, stdout.rows ?? 24, stdout.columns ?? 80);
	const draw = (lines: string[]) => {
		// Back to the first line of the last frame, then erase down from there.
		const up = drawn > 1 ? `\x1b[${drawn - 1}A` : "";
		stdout.write(`${up}\r\x1b[J${lines.join("\n")}`);
		drawn = lines.length;
	};
	return new Promise<PickerResult>((resolve, reject) => {
		let finished = false;
		// An incomplete escape sequence waiting for the rest of it, and the timer that ends the wait.
		let pending = "";
		let held: ReturnType<typeof setTimeout> | undefined;
		const finish = (outcome: { result: PickerResult } | { error: unknown }) => {
			if (finished) return;
			finished = true;
			clearTimeout(held);
			stopListening();
			restore();
			if ("error" in outcome) reject(outcome.error);
			else resolve(outcome.result);
		};
		const stopListening = () => {
			host.off("exit", onExit);
			for (const signal of SIGNALS) host.off(signal, onSignal[signal]);
			stdin.off("data", onData);
			stdin.off("end", onEnd);
		};
		// Restoring must not stop halfway: a write that fails here must not keep the terminal raw.
		const restore = () => {
			try {
				stdin.setRawMode?.(false);
				stdin.pause();
			} catch {}
			try {
				draw([]);
			} catch {}
			try {
				stdout.write("\x1b[?25h");
			} catch {}
		};
		// A signal: restore, stop listening so its default action applies, then raise it again. The promise never settles.
		const onSignal = Object.fromEntries(
			SIGNALS.map((signal) => [
				signal,
				() => {
					if (finished) return;
					finished = true;
					clearTimeout(held);
					stopListening();
					restore();
					host.kill(host.pid, signal);
				},
			]),
		) as Record<(typeof SIGNALS)[number], () => void>;
		// The process is going away without finish (exit, a throw elsewhere): leave the terminal usable.
		const onExit = () => {
			try {
				stdin.setRawMode?.(false);
				stdout.write("\x1b[?25h");
			} catch {}
		};
		/** Applies the keys of some input; true when the picker ended. */
		const handle = (text: string): boolean => {
			for (const key of parseKeys(text)) {
				const next = step(state, key);
				if ("done" in next) {
					finish({ result: { item: next.done, interrupted: next.interrupted === true } });
					return true;
				}
				state = next.state;
			}
			draw(render());
			return false;
		};
		const guarded = (run: () => void) => {
			try {
				run();
			} catch (error) {
				finish({ error });
			}
		};
		const onData = (data: Buffer | string) =>
			guarded(() => {
				clearTimeout(held);
				const text = pending + data.toString();
				pending = "";
				const [complete, tail] = splitIncomplete(text);
				if (tail === "") {
					handle(text);
					return;
				}
				// An incomplete sequence at the end may be one the terminal split: hold it for the next chunk.
				if (complete !== "" && handle(complete)) return;
				pending = tail;
				held = setTimeout(() => guarded(() => {
					pending = "";
					// A lone ESC is the Esc key; any other half sequence is dropped.
					if (tail === "\x1b") handle("\x1b");
				}), escapeWaitMs);
			});
		const onEnd = () => finish({ result: { item: undefined, interrupted: false } });
		host.on("exit", onExit);
		for (const signal of SIGNALS) host.once(signal, onSignal[signal]);
		guarded(() => {
			stdin.setRawMode?.(true);
			stdout.write("\x1b[?25l");
			draw(render());
			stdin.on("data", onData);
			stdin.once("end", onEnd);
			stdin.resume();
		});
	});
}
