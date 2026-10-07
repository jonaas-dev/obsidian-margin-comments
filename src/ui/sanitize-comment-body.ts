/**
 * Keep a comment body from reaching out to the network.
 *
 * #199 settled that comment bodies are less trusted than notes: they are
 * Markdown in sidecar files, so in a shared vault whoever can write those files
 * can put anything in them. SECURITY.md promises remote images "cannot be used
 * as network beacons".
 *
 * This used to be three regexes over the Markdown source, and #263 measured what
 * they let through: twelve of twelve hostile forms issued a real request inside
 * Obsidian — angle-bracket destinations, reference-style images, `srcset`,
 * `<picture>`, `<iframe>`, autoplaying `<video>` and `<audio>`. One of them,
 * `&#104;ttps://…`, arrives at the DOM already decoded, which rules out matching
 * the source text however carefully: the renderer is not finished with it yet.
 *
 * So the body is rendered first and cleaned after — but inside a document whose
 * images do not load, because an element starts fetching the moment its `src` is
 * set, attached or not.
 */

/** Elements that fetch something by themselves, with the attributes they fetch from. */
export const LOADERS: Record<string, readonly string[]> = {
	img: ["src", "srcset", "lowsrc"],
	source: ["src", "srcset"],
	video: ["src", "poster"],
	audio: ["src"],
	track: ["src"],
	iframe: ["src", "srcdoc"],
	embed: ["src"],
	object: ["data"],
	input: ["src"],
	// SVG. `<svg><image href="…">` was measured fetching on 2026-10-07, which the
	// list above never looked at: it is not an `img`, and its URL is in `href`.
	image: ["href", "xlink:href"],
	use: ["href", "xlink:href"],
	link: ["href"],
};

/**
 * Loaders that carry no meaning of their own, so refusing the fetch leaves nothing
 * worth linking to.
 *
 * A `<source>` is one of several candidates its parent picks among. An SVG `<image>`
 * or `<use>` only means something inside its `<svg>`, where an HTML `<a>` would be
 * foreign markup. A `<link>` is document plumbing that was never visible.
 */
export const DROPPED = new Set(["source", "image", "use", "link"]);

/**
 * Attributes that make any element fetch, whatever the element is.
 *
 * `background` is HTML 3.2 and long deprecated, which is exactly why it was missed:
 * `<table background="https://…">` was measured issuing the request on 2026-10-07.
 */
export const LOADING_ATTRIBUTES = ["background"] as const;

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

/**
 * The first remote URL a stylesheet or a `style` attribute fetches, or null.
 *
 * CSS reaches the network without any of the attributes LOADERS names:
 * `<div style="background-image:url(https://…)">` was measured fetching on
 * 2026-10-07. The element is ordinary content, so the fix is to drop the styling
 * rather than the element.
 */
export function remoteUrlInCss(css: string): string | null {
	for (const match of css.matchAll(CSS_URL)) {
		const url = match[1] ?? match[2] ?? match[3] ?? "";
		if (isRemote(url)) return url;
	}
	return null;
}

/**
 * Whether a URL leaves the vault.
 *
 * Anything with a scheme other than the app's own, and anything protocol-
 * relative, is remote. A plain relative path resolves inside the vault and does
 * not phone home, which is why local images keep working.
 *
 * Exported because this is where the decisions live that are worth pinning one
 * by one; the DOM surgery around it is covered end to end by the E2E suite.
 */
export function isRemote(url: string): boolean {
	const value = url.trim();
	if (value === "") return false;
	if (value.startsWith("//")) return true;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
	if (scheme === null) return false;
	// app:// is how Obsidian serves a file out of the vault itself.
	return scheme[1].toLowerCase() !== "app";
}

/**
 * The remote URL in one attribute's value, or null when there is none.
 *
 * `srcset` is a comma-separated list of candidates, each of them a URL followed
 * by a descriptor, so it needs taking apart rather than testing whole — which is
 * one of the forms #263 measured leaving the machine.
 */
export function remoteUrlIn(attribute: string, value: string): string | null {
	const urls =
		attribute === "srcset" ? value.split(",").map((c) => c.trim().split(/\s+/)[0]) : [value];
	for (const url of urls) if (isRemote(url)) return url;
	return null;
}

/**
 * Obsidian embeds render another note inline, which in a comment card is the
 * same as opening a note the reader did not ask to read (#199). Dropping the
 * leading `!` leaves the link. Done on the source because an embed is Obsidian's
 * own syntax, and it loads nothing remote — it is a reading decision, not a
 * network one.
 */
export function sanitizeCommentBody(body: string): string {
	return body.replace(/!\[\[([^\]]+)\]\]/g, "[[$1]]");
}
