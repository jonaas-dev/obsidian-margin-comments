import { describe, it, expect } from "vitest";
import { formatHotkey, hotkeyHint } from "../../src/ui/hotkey";

describe("formatHotkey", () => {
	const modShiftM = { modifiers: ["Mod", "Shift"], key: "M" };

	it("resolves Mod per platform, which is the point", () => {
		// Obsidian stores Mod unresolved: Command on macOS, Control elsewhere.
		// A hardcoded label is wrong on one of the two.
		expect(formatHotkey(modShiftM, true)).toBe("⇧⌘M");
		expect(formatHotkey(modShiftM, false)).toBe("Ctrl+Shift+M");
	});

	it("writes macOS without separators and the rest with them", () => {
		expect(formatHotkey({ modifiers: ["Alt"], key: "k" }, true)).toBe("⌥K");
		expect(formatHotkey({ modifiers: ["Alt"], key: "k" }, false)).toBe("Alt+K");
	});

	it("leaves a named key alone and upper-cases a single letter", () => {
		// "Enter" must not become "ENTER", and "m" must not stay lowercase.
		expect(formatHotkey({ modifiers: [], key: "Enter" }, true)).toBe("Enter");
		expect(formatHotkey({ modifiers: [], key: "m" }, false)).toBe("M");
	});

	it("passes through a modifier it does not know rather than dropping it", () => {
		// Losing a modifier silently would print a binding that does nothing.
		expect(formatHotkey({ modifiers: ["Hyper"], key: "K" }, false)).toBe("Hyper+K");
	});

	it("writes modifiers in the platform's order, not the stored order", () => {
		// macOS menus read ⌃⌥⇧⌘, so Shift comes before Command whichever way
		// round the binding was saved.
		const stored = { modifiers: ["Mod", "Alt", "Shift"], key: "M" };
		expect(formatHotkey(stored, true)).toBe("⌥⇧⌘M");
		expect(formatHotkey({ modifiers: ["Shift", "Mod"], key: "M" }, true)).toBe("⇧⌘M");
		expect(formatHotkey(stored, false)).toBe("Ctrl+Alt+Shift+M");
	});
});

describe("hotkeyHint", () => {
	it("names the key when there is one", () => {
		expect(hotkeyHint({ modifiers: ["Mod"], key: "M" }, true, "Add comment to selection")).toBe(
			"Select some text and press ⌘M.",
		);
	});

	it("names the command when the binding has been cleared", () => {
		// A reader who unbound it must not be told to press a key that does
		// nothing — the case a hardcoded default gets wrong and never notices.
		expect(hotkeyHint(null, true, "Add comment to selection")).toBe(
			"Select some text and run “Add comment to selection”.",
		);
	});
});
