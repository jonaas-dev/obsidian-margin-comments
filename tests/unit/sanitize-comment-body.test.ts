import { describe, it, expect } from "vitest";
import {
	DROPPED,
	LOADERS,
	LOADING_ATTRIBUTES,
	isRemote,
	remoteUrlIn,
	remoteUrlInCss,
	sanitizeCommentBody,
} from "../../src/ui/sanitize-comment-body";

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
		expect(isRemote("https://evil.example/a.png")).toBe(true);
		expect(isRemote("http://evil.example/a.png")).toBe(true);
	});

	it("calls a protocol-relative URL remote", () => {
		// Inherits the page's scheme and leaves the machine just the same.
		expect(isRemote("//evil.example/a.png")).toBe(true);
	});

	it("calls any other scheme remote", () => {
		// Not an allow-list of the ones we thought of: anything with a scheme that
		// is not Obsidian's own is treated as leaving the vault.
		expect(isRemote("ftp://evil.example/a.png")).toBe(true);
		expect(isRemote("data:image/png;base64,AAAA")).toBe(true);
		expect(isRemote("blob:https://evil.example/x")).toBe(true);
	});

	it("leaves a path inside the vault alone", () => {
		expect(isRemote("local.png")).toBe(false);
		expect(isRemote("folder/local.png")).toBe(false);
		expect(isRemote("/folder/local.png")).toBe(false);
		expect(isRemote("./local.png")).toBe(false);
	});

	it("leaves app:// alone, which is how Obsidian serves its own files", () => {
		expect(isRemote("app://local/path/to/image.png")).toBe(false);
		expect(isRemote("APP://local/path/to/image.png")).toBe(false);
	});

	it("is not fooled by surrounding space", () => {
		expect(isRemote("  https://evil.example/a.png  ")).toBe(true);
		expect(isRemote("   ")).toBe(false);
	});
});

describe("remoteUrlIn", () => {
	it("finds the URL in a plain attribute", () => {
		expect(remoteUrlIn("src", "https://evil.example/a.png")).toBe("https://evil.example/a.png");
	});

	it("takes a srcset apart rather than testing it whole", () => {
		// A srcset is candidates separated by commas, each a URL and a descriptor.
		// Tested whole it matches nothing, which is how it reached the network.
		expect(remoteUrlIn("srcset", "https://evil.example/a.png 1x")).toBe(
			"https://evil.example/a.png",
		);
	});

	it("finds a remote candidate that is not the first", () => {
		expect(remoteUrlIn("srcset", "local.png 1x, https://evil.example/b.png 2x")).toBe(
			"https://evil.example/b.png",
		);
	});

	it("says nothing when every candidate is inside the vault", () => {
		expect(remoteUrlIn("srcset", "local.png 1x, folder/other.png 2x")).toBeNull();
		expect(remoteUrlIn("src", "local.png")).toBeNull();
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

// Three of these left the machine when the audit of 2026-10-07 measured them, and
// none of the three went through an attribute LOADERS named at the time. The E2E
// suite asserts on the network; these pin the decisions underneath it.
describe("the routes around the loader table", () => {
	describe("remoteUrlInCss", () => {
		it.each([
			["double quotes", 'background-image:url("https://evil.example/a.png")'],
			["single quotes", "background:url('https://evil.example/a.png')"],
			["no quotes", "background:url(https://evil.example/a.png)"],
			["padded", "background:url(  https://evil.example/a.png  )"],
			["protocol-relative", "background:url(//evil.example/a.png)"],
			["uppercase URL(", "background:URL(https://evil.example/a.png)"],
			["second of two", "background:url(local.png),url(https://evil.example/a.png)"],
		])("finds the remote url with %s", (_name, css) => {
			expect(remoteUrlInCss(css)).toContain("evil.example");
		});

		it.each([
			["nothing to fetch", "color: red"],
			["a vault-relative image", "background:url(pictures/local.png)"],
			["the app's own scheme", "background:url(app://local/x.png)"],
			["an empty url", "background:url()"],
		])("leaves alone a style with %s", (_name, css) => {
			expect(remoteUrlInCss(css)).toBeNull();
		});
	});

	it("looks at the SVG elements that fetch through href rather than src", () => {
		// <svg><image href="https://…"> was measured issuing the request.
		expect(LOADERS.image).toContain("href");
		expect(LOADERS.use).toContain("href");
		expect(remoteUrlIn("href", "https://evil.example/a.svg")).toBe(
			"https://evil.example/a.svg",
		);
	});

	it("drops the loaders that would leave foreign markup behind", () => {
		// An HTML <a> inside an <svg>, or in place of a <link>, is not a thing a
		// reader can use; these go rather than becoming a link.
		expect([...DROPPED].sort()).toEqual(["image", "link", "source", "use"]);
	});

	it("knows background fetches from any element at all", () => {
		// <table background="https://…"> was measured issuing the request. There is
		// no tag to look up, which is why it needs its own list.
		expect([...LOADING_ATTRIBUTES]).toEqual(["background"]);
	});
});
