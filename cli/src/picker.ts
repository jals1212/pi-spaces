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

/**
 * The lines of one frame: the hint, the filter, then the items under a header per group (when they have
 * groups), with the cursor and the active mark. Only a window around the cursor is drawn when the list is
 * longer than the terminal (`rows` lines), with a line that says how many more are above and below.
 */
export function renderPicker(state: PickerState, rows: number): string[] {
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
	// Leave a line for the shell prompt; two lines may say there is more.
	const room = Math.max(3, rows - head.length - 1);
	if (body.length <= room) return [...head, ...body];
	const size = room - 2;
	const start = Math.min(Math.max(0, at - Math.floor(size / 2)), body.length - size);
	const end = start + size;
	const above = start > 0 ? [`  … ${start} more above`] : [];
	const below = end < body.length ? [`  … ${body.length - end} more below`] : [];
	return [...head, ...above, ...body.slice(start, end), ...below];
}

export interface PickerTerminal {
	stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
	stdout: { write(text: string): unknown; rows?: number };
}

/** The chosen item, none when cancelled (Esc, Ctrl-D, the end of input), and whether it was Ctrl-C. */
export interface PickerResult {
	item: PickerItem | undefined;
	interrupted: boolean;
}

/**
 * Runs the picker on a terminal: raw mode while it runs, each frame drawn over the last, and everything put
 * back before it returns (raw mode off, the picker erased, the cursor shown, stdin paused) so Pi can start clean.
 */
export function runPicker(items: PickerItem[], terminal: PickerTerminal): Promise<PickerResult> {
	const { stdin, stdout } = terminal;
	let state = initialState(items);
	let drawn = 0;
	const draw = (lines: string[]) => {
		// Back to the first line of the last frame, then erase down from there.
		const up = drawn > 1 ? `\x1b[${drawn - 1}A` : "";
		stdout.write(`${up}\r\x1b[J${lines.join("\n")}`);
		drawn = lines.length;
	};
	return new Promise<PickerResult>((resolve) => {
		const finish = (result: PickerResult) => {
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.setRawMode?.(false);
			stdin.pause();
			draw([]);
			stdout.write("\x1b[?25h");
			resolve(result);
		};
		const onData = (data: Buffer | string) => {
			for (const key of parseKeys(data.toString())) {
				const next = step(state, key);
				if ("done" in next) return finish({ item: next.done, interrupted: next.interrupted === true });
				state = next.state;
			}
			draw(renderPicker(state, stdout.rows ?? 24));
		};
		const onEnd = () => finish({ item: undefined, interrupted: false });
		stdin.setRawMode?.(true);
		stdout.write("\x1b[?25l");
		draw(renderPicker(state, stdout.rows ?? 24));
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		stdin.resume();
	});
}
