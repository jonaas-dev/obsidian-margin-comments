import { describe, it, expect } from "vitest";
import { keyIntent } from "../../src/ui/key-intent";

const key = (init: Partial<KeyboardEvent> & { key: string }) => init as KeyboardEvent;

describe("keyIntent", () => {
	it("submits on Enter", () => {
		expect(keyIntent(key({ key: "Enter" }))).toBe("submit");
	});

	it("breaks the line on Shift+Enter", () => {
		expect(keyIntent(key({ key: "Enter", shiftKey: true }))).toBe("newline");
	});

	it("still submits on Cmd+Enter", () => {
		// The habit people bring from every other comment box; breaking it would
		// be a gratuitous surprise even once Enter alone works.
		expect(keyIntent(key({ key: "Enter", metaKey: true }))).toBe("submit");
	});

	it("still submits on Ctrl+Enter", () => {
		expect(keyIntent(key({ key: "Enter", ctrlKey: true }))).toBe("submit");
	});

	it("cancels on Escape", () => {
		expect(keyIntent(key({ key: "Escape" }))).toBe("cancel");
	});

	it("ignores ordinary typing", () => {
		expect(keyIntent(key({ key: "a" }))).toBe("ignore");
	});

	it("ignores Enter combined with Alt, which is not a send gesture", () => {
		expect(keyIntent(key({ key: "Enter", altKey: true }))).toBe("newline");
	});
});
