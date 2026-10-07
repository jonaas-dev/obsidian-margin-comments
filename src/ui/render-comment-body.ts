import { MarkdownRenderer, type App, type Component } from "obsidian";
import {
	DROPPED,
	LOADERS,
	LOADING_ATTRIBUTES,
	isRemote,
	remoteUrlIn,
	remoteUrlInCss,
	sanitizeCommentBody,
} from "./sanitize-comment-body";

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
function firstRemote(el: Element, attributes: readonly string[]): string | null {
	for (const attribute of attributes) {
		const value = el.getAttribute(attribute);
		if (value === null) continue;
		const url = remoteUrlIn(attribute, value);
		if (url !== null) return url;
	}
	return null;
}

function neutraliseRemoteLoads(root: HTMLElement): void {
	for (const [tag, attributes] of Object.entries(LOADERS)) {
		for (const el of Array.from(root.querySelectorAll(tag))) {
			const target = firstRemote(el, attributes);
			if (target === null) continue;

			if (DROPPED.has(tag)) {
				el.remove();
				continue;
			}

			// createEl, not `el.ownerDocument.createElement`: the rule's suggested
			// `ownerDocument.win.createEl` cannot work here, because this document is
			// deliberately one with no browsing context and its `win` is null — which
			// is the whole reason nothing in it fetches. The link is built in the
			// global document and `replaceWith` adopts it, which is a no-op away from
			// where it ends up: every node here is adopted into the card below (#336).
			const link = createEl("a");
			link.setAttribute("href", target);
			link.setAttribute("rel", "noopener noreferrer");
			const alt = el.getAttribute("alt")?.trim();
			link.textContent = alt && alt !== "" ? alt : describe(tag);
			el.replaceWith(link);
		}
	}
	neutraliseLoadingAttributes(root);
}

/**
 * Take the fetch off elements that are ordinary content carrying a loading
 * attribute, and drop stylesheets that fetch.
 *
 * These route around the table above entirely: a `style` attribute with
 * `url(…)`, or the deprecated `background` attribute, fetches from any element
 * at all, so there is no tag to look up. The attribute goes rather than the
 * element — a styled paragraph is still a paragraph, and removing it would take
 * the comment's text with it.
 */
function neutraliseLoadingAttributes(root: HTMLElement): void {
	for (const el of Array.from(root.querySelectorAll("*"))) {
		for (const attribute of LOADING_ATTRIBUTES) {
			const value = el.getAttribute(attribute);
			if (value !== null && isRemote(value)) el.removeAttribute(attribute);
		}
		const style = el.getAttribute("style");
		if (style !== null && remoteUrlInCss(style) !== null) el.removeAttribute("style");
	}
	// A <style> block is not content, so it goes whole. This one was not measured
	// reaching the network on 2026-10-07 — Obsidian appears to drop it first — and
	// is here because it is the same hole as the attribute above, one renderer
	// change away from being open.
	for (const el of Array.from(root.querySelectorAll("style"))) {
		if (remoteUrlInCss(el.textContent ?? "") !== null) el.remove();
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
	// `inert.body` is the holder. It used to be a <div> created inside the inert
	// document, which bought nothing: the body is already an HTMLElement the renderer
	// accepts, and creating the div was the second site the directory review flagged
	// for not using Obsidian's helpers — helpers that cannot run here (#336).
	const inert = target.ownerDocument.implementation.createHTMLDocument("");
	const holder = inert.body;

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
