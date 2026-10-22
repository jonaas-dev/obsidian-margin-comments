import { describe, it, expect } from "vitest";
import {
	CSS_VALUE_ATTRIBUTES,
	DROPPED,
	LOADERS,
	URL_ATTRIBUTES,
	isRemote,
	keepsCssValue,
	linkTarget,
	remoteUrlIn,
	sanitizeCommentBody,
} from "../../src/ui/sanitize-comment-body";

/** What document.baseURI is in Obsidian on desktop, and in the Android app. */
const DESKTOP = "app://obsidian.md/index.html";
const PHONE = "http://localhost/";

/**
 * #263 replaced a set of regexes over the Markdown source with a pass over the
 * rendered DOM, after measuring that twelve of twelve hostile forms got through
 * the regexes and issued a real request. The old tests pinned the rewriting the
 * regexes did, so they pinned the wrong mechanism; what is worth pinning now is
 * the one decision the DOM pass makes per URL.
 *
 * The surgery itself needs a document, which the unit environment does not have.
 * tests/e2e/comment-body-beacons.test.ts drives it against a real Obsidian and
 * watches the network.
 */
describe("isRemote", () => {
	it("calls http and https remote", () => {
		expect(isRemote("https://evil.example/a.png", DESKTOP)).toBe(true);
		expect(isRemote("http://evil.example/a.png", DESKTOP)).toBe(true);
	});

	it("calls any other scheme remote", () => {
		expect(isRemote("ftp://evil.example/a.png", DESKTOP)).toBe(true);
		expect(isRemote("data:image/png;base64,AAAA", DESKTOP)).toBe(true);
		expect(isRemote("blob:https://evil.example/x", DESKTOP)).toBe(true);
	});

	it("leaves a path inside the vault alone", () => {
		for (const base of [DESKTOP, PHONE]) {
			expect(isRemote("local.png", base)).toBe(false);
			expect(isRemote("folder/local.png", base)).toBe(false);
			expect(isRemote("/folder/local.png", base)).toBe(false);
			expect(isRemote("./local.png", base)).toBe(false);
			expect(isRemote("", base)).toBe(false);
		}
	});

	it("leaves app:// alone, which is how Obsidian serves its own files", () => {
		expect(isRemote("app://local/path/to/image.png", DESKTOP)).toBe(false);
		expect(isRemote("APP://local/path/to/image.png", DESKTOP)).toBe(false);
	});

	it("leaves alone the origin a phone serves the vault from, and only that", () => {
		expect(isRemote("http://localhost/_capacitor_file_/vault/a.png", PHONE)).toBe(false);
		expect(isRemote("http://localhost:8080/a.png", PHONE)).toBe(true);
		expect(isRemote("https://localhost/a.png", PHONE)).toBe(true);
	});

	it("decides on the URL as resolved, not as written", () => {
		// Protocol-relative is app:// on desktop and the web on a phone.
		expect(isRemote("//evil.example/a.png", DESKTOP)).toBe(false);
		expect(isRemote("//evil.example/a.png", PHONE)).toBe(true);
		expect(isRemote("  https://evil.example/a.png  ", DESKTOP)).toBe(true);
	});

	it("calls remote what does not resolve", () => {
		expect(isRemote("http://[", DESKTOP)).toBe(true);
	});
});

describe("remoteUrlIn", () => {
	it("finds the URL in a plain attribute", () => {
		expect(remoteUrlIn("src", "https://evil.example/a.png", DESKTOP)).toBe(
			"https://evil.example/a.png",
		);
	});

	it("takes a srcset apart rather than testing it whole", () => {
		expect(remoteUrlIn("srcset", "https://evil.example/a.png 1x", DESKTOP)).toBe(
			"https://evil.example/a.png",
		);
		expect(remoteUrlIn("imagesrcset", "https://evil.example/a.png 1x", DESKTOP)).toBe(
			"https://evil.example/a.png",
		);
	});

	it("finds a remote candidate that is not the first", () => {
		expect(remoteUrlIn("srcset", "local.png 1x, https://evil.example/b.png 2x", DESKTOP)).toBe(
			"https://evil.example/b.png",
		);
	});

	it("finds a remote candidate however the list is spaced", () => {
		expect(remoteUrlIn("srcset", "local.png,https://evil.example/b.png", DESKTOP)).toBe(
			"https://evil.example/b.png",
		);
	});

	it("says nothing when every candidate is inside the vault", () => {
		expect(remoteUrlIn("srcset", "local.png 1x, folder/other.png 2x", DESKTOP)).toBeNull();
		expect(remoteUrlIn("srcset", "local.png 1x, folder/other.png 2x", PHONE)).toBeNull();
		expect(remoteUrlIn("src", "local.png", DESKTOP)).toBeNull();
	});
});

describe("linkTarget", () => {
	const BASE = "app://obsidian.md/index.html";

	it("offers a web address as a link", () => {
		expect(linkTarget("https://example.com/a.png", BASE)).toBe("https://example.com/a.png");
		expect(linkTarget("http://example.com/a.png", BASE)).toBe("http://example.com/a.png");
		expect(linkTarget("  HTTPS://Example.com/a.png ", BASE)).toBe("https://example.com/a.png");
	});

	it("offers nothing else", () => {
		for (const url of [
			"javascript:void(0)",
			"JaVaScRiPt:void(0)",
			"java\tscript:void(0)",
			"data:text/html,x",
			"vbscript:x",
			"file:///etc/hosts",
			"app://obsidian.md/x",
			"blob:https://example.com/x",
			"ftp://example.com/x",
		]) {
			expect(linkTarget(url, BASE), url).toBeNull();
		}
	});

	it("reads a URL against the base it will be followed from", () => {
		// Protocol-relative is web on a phone, served over http(s), and not on
		// desktop, served over app://.
		expect(linkTarget("//example.com/a.png", BASE)).toBeNull();
		expect(linkTarget("//example.com/a.png", "https://localhost/")).toBe(
			"https://example.com/a.png",
		);
	});

	it("offers nothing for what does not parse", () => {
		expect(linkTarget("http://[", BASE)).toBeNull();
	});
});

describe("sanitizeCommentBody", () => {
	it("downgrades an embed to a link", () => {
		// An embed renders another note inside the card, which is reading a note
		// nobody asked for (#199). It loads nothing remote, so it stays here on the
		// source rather than moving to the DOM pass.
		expect(sanitizeCommentBody("![[another note]]")).toBe("[[another note]]");
	});

	it("leaves an ordinary internal link alone", () => {
		expect(sanitizeCommentBody("[[another note]]")).toBe("[[another note]]");
	});

	it("downgrades every embed in a body, not just the first", () => {
		expect(sanitizeCommentBody("![[a]] and ![[b]]")).toBe("[[a]] and [[b]]");
	});

	it("no longer rewrites image syntax, which the DOM pass handles", () => {
		// Deliberate: rewriting the source could not see `&#104;ttps://…`, which
		// reaches the DOM already decoded (#263).
		const body = "![a](https://evil.example/a.png)";
		expect(sanitizeCommentBody(body)).toBe(body);
	});

	it("leaves text inside code alone", () => {
		// The regexes used to rewrite here too, changing text the author wrote as
		// code into something they did not write.
		const body = "`![](https://example.com/x.png)`";
		expect(sanitizeCommentBody(body)).toBe(body);
	});
});

describe("the routes around the loader table", () => {
	it("looks at the SVG elements that fetch through href rather than src", () => {
		// <svg><image href="https://…"> was measured issuing the request.
		expect(LOADERS.image).toContain("href");
		expect(LOADERS.use).toContain("href");
	});

	it("drops the loaders that would leave foreign markup behind", () => {
		// An HTML <a> inside an <svg>, or in place of a <link>, is not a thing a
		// reader can use; these go rather than becoming a link.
		expect([...DROPPED].sort()).toEqual(["image", "link", "source", "use"]);
	});

	it("checks every attribute any loader fetches from, on any element", () => {
		// The attribute pass runs on every element, so a loader attribute missing
		// from it would only be caught on the elements the table names (#371).
		const urls: readonly string[] = URL_ATTRIBUTES;
		for (const attributes of Object.values(LOADERS)) {
			for (const attribute of attributes) {
				if (attribute !== "srcdoc") expect(urls).toContain(attribute);
			}
		}
		expect(urls).toContain("background");
	});

	it("reads the SVG attributes that take a CSS value", () => {
		expect([...CSS_VALUE_ATTRIBUTES]).toEqual(
			expect.arrayContaining(["fill", "stroke", "filter", "mask", "clip-path"]),
		);
	});
});

describe("keepsCssValue", () => {
	it.each([
		["a colour", "red"],
		["a hex colour", "#ff0000"],
		["none", "none"],
		["a reference inside the SVG", "url(#gradient)"],
		["a quoted reference inside the SVG", "url('#gradient')"],
		["a padded reference inside the SVG", "  url( #g )  "],
	])("keeps %s", (_name, value) => {
		expect(keepsCssValue(value)).toBe(true);
	});

	it.each([
		["a reference elsewhere", "url(https://example.com/a.svg#g)"],
		["a relative reference", "url(other.svg#g)"],
		["a reference with a fallback", "url(#g) red"],
		["a function", "rgb(0, 0, 0)"],
		["an escape", "\\75rl(x)"],
		["a quote", '"x"'],
	])("drops %s", (_name, value) => {
		expect(keepsCssValue(value)).toBe(false);
	});

	it("stays fast on a long value", () => {
		const started = Date.now();
		keepsCssValue(`url(${" ".repeat(200_000)}#${"a".repeat(200_000)}`);
		keepsCssValue(" ".repeat(200_000) + "x");
		expect(Date.now() - started).toBeLessThan(100);
	});
});
