/** A binding as Obsidian's hotkey manager reports it. */
export interface Binding {
	modifiers: string[];
	key: string;
}

const MAC_SYMBOLS: Record<string, string> = {
	Mod: "⌘",
	Meta: "⌘",
	Ctrl: "⌃",
	Alt: "⌥",
	Shift: "⇧",
};

const OTHER_NAMES: Record<string, string> = {
	Mod: "Ctrl",
	Meta: "Win",
	Ctrl: "Ctrl",
	Alt: "Alt",
	Shift: "Shift",
};

/**
 * Canonical order, not the order the binding happens to be stored in.
 *
 * macOS writes ⌃⌥⇧⌘ and every native menu follows it, so ⇧⌘M rather than
 * ⌘⇧M. Elsewhere the convention is Ctrl, Alt, Shift. A modifier not on the
 * list keeps its place at the end rather than being dropped.
 */
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Mod", "Meta"];
const OTHER_ORDER = ["Mod", "Meta", "Ctrl", "Alt", "Shift"];

function ordered(modifiers: string[], order: string[]): string[] {
	const rank = (mod: string): number => {
		const at = order.indexOf(mod);
		return at === -1 ? order.length : at;
	};
	return [...modifiers].sort((a, b) => rank(a) - rank(b));
}

/**
 * A binding written the way the platform writes it.
 *
 * `Mod` is the whole reason this exists: Obsidian stores it unresolved, and it
 * means Command on macOS and Control everywhere else — so a hardcoded label is
 * wrong on one of the two.
 */
export function formatHotkey(binding: Binding, mac: boolean): string {
	const parts = ordered(binding.modifiers, mac ? MAC_ORDER : OTHER_ORDER).map((mod) =>
		mac ? (MAC_SYMBOLS[mod] ?? mod) : (OTHER_NAMES[mod] ?? mod),
	);
	const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
	return mac ? [...parts, key].join("") : [...parts, key].join("+");
}

/**
 * What the panel says when a note has no comments yet.
 *
 * A reader who has cleared the binding is told about the command, not about a
 * key that would do nothing — which is the case a hardcoded default would get
 * wrong and never notice.
 */
export function hotkeyHint(binding: Binding | null, mac: boolean, commandName: string): string {
	if (!binding) return `Select some text and run “${commandName}”.`;
	return `Select some text and press ${formatHotkey(binding, mac)}.`;
}
