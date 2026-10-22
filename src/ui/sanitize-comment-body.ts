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
 * Every attribute that takes a URL, on whatever element carries it.
 *
 * A list of what can fetch rather than of where fetching was seen: the element
 * by element table above kept missing one (#371). The lists come from the HTML,
 * SVG and obsolete HTML attribute indexes. A link's own `href` is the exception,
 * handled where it is checked, because following a link is the reader's choice.
 */
export const URL_ATTRIBUTES = [
	"href",
	"xlink:href",
	"src",
	"srcset",
	"imagesrcset",
	"lowsrc",
	"dynsrc",
	"data",
	"poster",
	"background",
	"action",
	"formaction",
	"ping",
	"cite",
	"longdesc",
	"manifest",
	"codebase",
	"archive",
	"classid",
	"profile",
	"icon",
] as const;

/**
 * SVG attributes whose value is read as CSS, so a reference in them can fetch
 * without any attribute above being involved.
 */
export const CSS_VALUE_ATTRIBUTES = [
	"fill",
	"stroke",
	"filter",
	"mask",
	"clip-path",
	"marker-start",
	"marker-mid",
	"marker-end",
	"cursor",
] as const;

/**
 * Whether a CSS-valued attribute can stay as written.
 *
 * Only plain values and a reference to something in the same SVG: those are what
 * SVG in a comment needs, and anything with a function, a quote or an escape in
 * it is CSS this does not try to read (#371). A colour given as `rgb(…)` is lost
 * with it, which is the price of not parsing CSS.
 */
export function keepsCssValue(value: string): boolean {
	if (/^\s*url\(\s*(["']?)#[\w.:-]*\1\s*\)\s*$/i.test(value)) return true;
	return !/[()\\"']/.test(value);
}

/**
 * Whether a URL leaves the vault, decided on the URL the page would resolve.
 *
 * `base` is the URI of the document the content ends up in. The URL is resolved
 * against it first, because the string as written is not what gets fetched
 * (#369). What stays inside is the app's own `app://` on desktop, and the origin
 * the app is served from on a phone, where vault files come from that origin
 * rather than from `app://`. A URL that does not resolve counts as remote.
 *
 * Exported because this is where the decisions live that are worth pinning one
 * by one; the DOM surgery around it is covered end to end by the E2E suite.
 */
export function isRemote(url: string, base: string): boolean {
	let resolved: URL;
	let home: URL;
	try {
		resolved = new URL(url, base);
		home = new URL(base);
	} catch {
		return true;
	}
	if (resolved.protocol === "app:") return false;
	return resolved.protocol !== home.protocol || resolved.host !== home.host;
}

/**
 * What a card may link to in place of content it does not show, or null.
 *
 * Only web addresses, resolved against `base` the way the link will be followed:
 * a reader is offered somewhere to go, and nothing else belongs in that place
 * (#368). The URL comes back resolved, so the link holds what was checked.
 */
export function linkTarget(url: string, base: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url.trim(), base);
	} catch {
		return null;
	}
	return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
}

/**
 * The remote URL in one attribute's value, or null when there is none.
 *
 * A `srcset` is a list of candidates, each a URL and a descriptor, so it is
 * taken apart rather than tested whole — one of the forms #263 measured leaving
 * the machine. Every token is tested: a descriptor resolves inside the vault, so
 * testing it costs nothing, and no reading of the list can skip a URL.
 */
export function remoteUrlIn(attribute: string, value: string, base: string): string | null {
	const urls =
		attribute === "srcset" || attribute === "imagesrcset"
			? value.split(/[\s,]+/).filter((token) => token !== "")
			: [value];
	for (const url of urls) if (isRemote(url, base)) return url;
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
