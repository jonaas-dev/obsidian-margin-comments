import { describe, it, expect, vi } from "vitest";
import { listenInEveryWindow, openDocuments } from "../../src/windows";

/** Just enough of a leaf to carry the document its view is drawn in. */
const leafIn = (doc: unknown) => ({ view: { containerEl: { ownerDocument: doc } } });

function workspaceWith(main: unknown, leafDocs: unknown[]) {
	const handlers = new Map<string, (arg: unknown) => void>();
	return {
		workspace: {
			containerEl: { ownerDocument: main },
			iterateAllLeaves: (fn: (leaf: unknown) => void) => leafDocs.map(leafIn).forEach(fn),
			on: (event: string, handler: (arg: unknown) => void) => {
				handlers.set(event, handler);
				return { event };
			},
		},
		/** Fire what the workspace would fire when a popout opens. */
		openWindow: (doc: unknown) => handlers.get("window-open")?.({ doc }),
	};
}

function componentSpy() {
	const registered: { doc: unknown; type: string }[] = [];
	return {
		registered,
		component: {
			registerDomEvent: (doc: unknown, type: string) => registered.push({ doc, type }),
			registerEvent: vi.fn(),
		},
	};
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("openDocuments", () => {
	it("puts the main window first", () => {
		const { workspace } = workspaceWith("main", ["popout"]);
		expect(openDocuments(workspace as any)[0]).toBe("main");
	});

	it("counts a window once however many leaves it holds", () => {
		// A popout with four leaves is still one document, and listening four times
		// would run the handler four times per click.
		const { workspace } = workspaceWith("main", ["popout", "popout", "popout"]);
		expect(openDocuments(workspace as any)).toEqual(["main", "popout"]);
	});

	it("does not list the main window twice when a leaf is in it", () => {
		const { workspace } = workspaceWith("main", ["main", "popout"]);
		expect(openDocuments(workspace as any)).toEqual(["main", "popout"]);
	});

	it("is just the main window when nothing is popped out", () => {
		const { workspace } = workspaceWith("main", ["main"]);
		expect(openDocuments(workspace as any)).toEqual(["main"]);
	});
});

describe("listenInEveryWindow", () => {
	it("listens in a popout that was already open", () => {
		// The gap #265 measured: window-open only fires for windows opened after it
		// is subscribed to, so reloading the plugin with a popout open left that
		// popout deaf.
		const { workspace } = workspaceWith("main", ["popout"]);
		const { registered, component } = componentSpy();

		listenInEveryWindow(component as any, workspace as any, "click", () => {});

		expect(registered).toEqual([
			{ doc: "main", type: "click" },
			{ doc: "popout", type: "click" },
		]);
	});

	it("listens in a popout opened afterwards", () => {
		const { workspace, openWindow } = workspaceWith("main", []);
		const { registered, component } = componentSpy();

		listenInEveryWindow(component as any, workspace as any, "click", () => {});
		openWindow("later");

		expect(registered.map((r) => r.doc)).toEqual(["main", "later"]);
	});

	it("does not listen twice when a window-open repeats one already open", () => {
		const { workspace, openWindow } = workspaceWith("main", ["popout"]);
		const { registered, component } = componentSpy();

		listenInEveryWindow(component as any, workspace as any, "click", () => {});
		openWindow("popout");

		expect(registered.map((r) => r.doc)).toEqual(["main", "popout"]);
	});
});
/* eslint-enable @typescript-eslint/no-explicit-any */
