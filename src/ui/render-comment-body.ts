function firstRemote(el: Element, attributes: readonly string[]): string | null {
	for (const attribute of attributes) {
		const value = el.getAttribute(attribute);
		if (value === null) continue;
		const url = remoteUrlIn(attribute, value);
		if (url !== null) return url;
	}
	return null;
}

import { MarkdownRenderer, type App, type Component } from "obsidian";
import { LOADERS, remoteUrlIn, sanitizeCommentBody } from "./sanitize-comment-body";

/**
 * Rendering a comment body without letting it reach the network.
 *
 * Kept apart from the decisions in sanitize-comment-body.ts because everything
 * here needs a document and an Obsidian to render with, so it is covered by the
 * E2E suite rather than by unit tests — see OBSIDIAN_BOUND_FILES.
 */

/**
 * Replace everything in `root` that would fetch from the network with a link.
 *
 * A link rather than nothing: the reader can still choose to follow it, which is
 * what the regex version did for the one shape it recognised, and removing the
 * content outright would hide that a comment had an image in it at all.
 *
 */
function neutraliseRemoteLoads(root: HTMLElement): void {
	for (const [tag, attributes] of Object.entries(LOADERS)) {
		for (const el of Array.from(root.querySelectorAll(tag))) {
			const target = firstRemote(el, attributes);
			if (target === null) continue;

			// A <source> inside <picture> or <video> has no meaning on its own: the
			// parent picks among them, so the one that would have been chosen is
			// simply removed and the parent's own src is handled in its turn.
			if (tag === "source") {
				el.remove();
				continue;
			}

			const link = el.ownerDocument.createElement("a");
			link.setAttribute("href", target);
			link.setAttribute("rel", "noopener noreferrer");
			const alt = el.getAttribute("alt")?.trim();
			link.textContent = alt && alt !== "" ? alt : describe(tag);
			el.replaceWith(link);
		}
	}
}

function describe(tag: string): string {
	if (tag === "img") return "image";
	if (tag === "iframe" || tag === "embed" || tag === "object") return "embedded page";
	return tag;
}


/**
 * Render a comment body into `target` without letting it fetch anything.
 *
 * The Markdown is rendered into a document made by createHTMLDocument, which has
 * no browsing context: an `<img>` there never starts a request, however its
 * `src` was spelled. Everything that would fetch is replaced, and only then are
 * the nodes adopted into the live card.
 *
 * Order is the whole point. Cleaning after rendering into the card is too late —
 * the request has already left.
 */
export async function renderCommentBody(
	app: App,
	body: string,
	target: HTMLElement,
	filePath: string,
	component: Component,
): Promise<void> {
	const inert = target.ownerDocument.implementation.createHTMLDocument("");
	const holder = inert.createElement("div");
	inert.body.appendChild(holder);

	// Started, not awaited to completion. A document with no browsing context never
	// loads an image, and the renderer's promise waits for the ones it rendered: #263
	// measured 9 of 20 renders never resolving, every one of them a body with an
	// image in it. The markup is in place well before that, and the images size
	// themselves once the nodes are adopted into the live card, where they do load.
	const rendering = MarkdownRenderer.render(
		app,
		sanitizeCommentBody(body),
		holder,
		filePath,
		component,
	);
	await Promise.race([rendering, settle(target)]);
	neutraliseRemoteLoads(holder);

	target.empty();
	// Adopted one at a time: appending a node from another document moves it, and
	// the loop has to read the list before it is emptied by the move.
	for (const node of Array.from(holder.childNodes)) {
		target.appendChild(target.ownerDocument.adoptNode(node));
	}
}

/**
 * Long enough for the renderer to have built its markup, and no longer.
 *
 * Two turns rather than one: the renderer hands off through a microtask before
 * its post-processors run, and a single turn caught bodies half-built.
 */
function settle(target: HTMLElement): Promise<void> {
	const win = target.ownerDocument.defaultView ?? window;
	return new Promise((resolve) => {
		win.setTimeout(() => win.setTimeout(() => resolve(), 0), 0);
	});
}
