import type { Component, Workspace } from "obsidian";

/**
 * Every document the workspace is currently showing anything in.
 *
 * A popout window is a document of its own, so a listener on the main window's
 * never hears a click in one (#236). Gathered from the leaves rather than from
 * a window list because that is the public way to reach them, and a window with
 * no leaf in it has nothing to listen to anyway.
 *
 * The main window's document is always first, and duplicates are dropped: a
 * popout holding four leaves is still one document.
 */
export function openDocuments(workspace: Workspace): Document[] {
	const documents: Document[] = [workspace.containerEl.ownerDocument];
	const seen = new Set<Document>(documents);
	workspace.iterateAllLeaves((leaf) => {
		const doc = leaf.view.containerEl.ownerDocument;
		if (seen.has(doc)) return;
		seen.add(doc);
		documents.push(doc);
	});
	return documents;
}

/**
 * Listen for an event in every window: the ones open now, and the ones opened later.
 *
 * `window-open` only fires for windows opened after it is subscribed to, so a
 * popout that already existed when the plugin loaded never got a listener —
 * which is every reload of the plugin with a popout open, and every relaunch
 * where the layout is restored first (#265). Registering on what is already
 * open is the half that was missing.
 *
 * Through the component's own `registerDomEvent`, so every listener is removed
 * when it unloads, popouts included.
 */
export function listenInEveryWindow(
	component: Component,
	workspace: Workspace,
	// Only the two the plugin needs. Typed concretely rather than over
	// DocumentEventMap, which is a type and not a global, so eslint's no-undef
	// cannot see it.
	type: "click" | "pointerdown",
	handler: (event: MouseEvent) => void,
): void {
	const seen = new Set<Document>();
	const listen = (doc: Document): void => {
		if (seen.has(doc)) return;
		seen.add(doc);
		component.registerDomEvent(doc, type, handler);
	};

	for (const doc of openDocuments(workspace)) listen(doc);
	component.registerEvent(workspace.on("window-open", (win) => listen(win.doc)));
}
