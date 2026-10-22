import { MarkdownRenderer, type App, type Component } from "obsidian";
import {
	CSS_VALUE_ATTRIBUTES,
	DROPPED,
	LOADERS,
	URL_ATTRIBUTES,
	keepsCssValue,
	linkTarget,
	remoteUrlIn,
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
function firstRemote(el: Element, attributes: readonly string[], base: string): string | null {
	for (const attribute of attributes) {
		const value = el.getAttribute(attribute);
		if (value === null) continue;
		const url = remoteUrlIn(attribute, value, base);
		if (url !== null) return url;
	}
	return null;
}

function neutraliseRemoteLoads(root: HTMLElement, base: string): void {
	for (const [tag, attributes] of Object.entries(LOADERS)) {
		for (const el of Array.from(root.querySelectorAll(tag))) {
			const target = firstRemote(el, attributes, base);
			if (target === null) continue;

			if (DROPPED.has(tag)) {
				el.remove();
				continue;
			}

			const alt = el.getAttribute("alt")?.trim();
			const href = linkTarget(target, base);
			if (href === null) {
				if (alt) el.replaceWith(alt);
				else el.remove();
				continue;
			}

			// createEl, not `el.ownerDocument.createElement`: the rule's suggested
			// `ownerDocument.win.createEl` cannot work here, because this document is
			// deliberately one with no browsing context and its `win` is null — which
			// is the whole reason nothing in it fetches. The link is built in the
			// global document and `replaceWith` adopts it, which is a no-op away from
			// where it ends up: every node here is adopted into the card below (#336).
			const link = createEl("a");
			link.setAttribute("href", href);
			link.setAttribute("rel", "noopener noreferrer");
			link.textContent = alt || describe(tag);
			el.replaceWith(link);
		}
	}
	neutraliseAttributes(root, base);
}

/**
 * Take the fetch off everything left: attributes on ordinary content, and styling.
 *
 * Attribute by attribute rather than tag by tag, because the table above is a
 * list of elements and the attributes route around it (#371). The attribute goes
 * rather than the element — a styled paragraph is still a paragraph, and removing
 * it would take the comment's text with it.
 *
 * Styling goes whole, attribute and `<style>` alike, whatever it says (#370):
 * CSS has more ways to fetch than any reading of it here would keep up with, and
 * a comment loses nothing it needs without it.
 */
function neutraliseAttributes(root: HTMLElement, base: string): void {
	for (const el of Array.from(root.querySelectorAll("*"))) {
		el.removeAttribute("style");
		const link = el.localName === "a";
		for (const attribute of URL_ATTRIBUTES) {
			if (link && (attribute === "href" || attribute === "xlink:href")) continue;
			const value = el.getAttribute(attribute);
			if (value !== null && remoteUrlIn(attribute, value, base) !== null) {
				el.removeAttribute(attribute);
			}
		}
		for (const attribute of CSS_VALUE_ATTRIBUTES) {
			const value = el.getAttribute(attribute);
			if (value !== null && !keepsCssValue(value)) el.removeAttribute(attribute);
		}
	}
	for (const el of Array.from(root.querySelectorAll("style"))) el.remove();
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
	// themselves once the nodes are copied into the live card, where they do load.
	const rendering = MarkdownRenderer.render(
		app,
		sanitizeCommentBody(body),
		holder,
		filePath,
		component,
	);
	await Promise.race([rendering, settle(target)]);
	// The live document's base, not the inert one's about:blank: the link is
	// followed from the card.
	neutraliseRemoteLoads(holder, target.ownerDocument.baseURI);

	target.empty();
	// Copied, not moved: the renderer keeps references to the nodes it built and
	// may write to them after the pass above (#372). Those writes land in the inert
	// document, where nothing loads, instead of in the card.
	for (const node of Array.from(holder.childNodes)) {
		target.appendChild(target.ownerDocument.importNode(node, true));
	}
	rewire(target, component);
}

/**
 * Give back the behaviour the renderer attached to the nodes it built.
 *
 * A copy carries no listeners, and these two were measured gone without this:
 * the code block's copy button copied nothing, and a folded callout would not
 * open. A folded callout's content also arrives visible, because what hid it was
 * a style, and styles are dropped above.
 */
function rewire(target: HTMLElement, component: Component): void {
	for (const button of Array.from(target.querySelectorAll<HTMLElement>(".copy-code-button"))) {
		const code = button.closest("pre")?.querySelector("code");
		component.registerDomEvent(button, "click", (event) => {
			event.stopPropagation();
			void navigator.clipboard.writeText(code?.textContent ?? "");
		});
	}
	for (const callout of Array.from(
		target.querySelectorAll<HTMLElement>(".callout.is-collapsible"),
	)) {
		const title = callout.querySelector<HTMLElement>(".callout-title");
		const content = callout.querySelector<HTMLElement>(".callout-content");
		content?.toggle(!callout.hasClass("is-collapsed"));
		if (!title) continue;
		component.registerDomEvent(title, "click", (event) => {
			event.stopPropagation();
			callout.toggleClass("is-collapsed", !callout.hasClass("is-collapsed"));
			content?.toggle(!callout.hasClass("is-collapsed"));
		});
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
