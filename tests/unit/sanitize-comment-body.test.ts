import { describe, expect, it } from "vitest";
import { sanitizeCommentBody } from "../../src/ui/sanitize-comment-body";

describe("sanitizeCommentBody", () => {
	it("leaves local markdown images alone", () => {
		const input = "![diagram](attachments/diagram.png)";
		expect(sanitizeCommentBody(input)).toBe(input);
	});

	it("downgrades remote http images to links", () => {
		expect(sanitizeCommentBody("![](http://example.com/pixel.gif)")).toBe(
			"[image](http://example.com/pixel.gif)",
		);
	});

	it("downgrades remote https images to links", () => {
		expect(sanitizeCommentBody("![screenshot](https://example.com/shot.png)")).toBe(
			"[screenshot](https://example.com/shot.png)",
		);
	});

	it("downgrades protocol-relative images to links", () => {
		expect(sanitizeCommentBody("![icon](//cdn.example.com/icon.svg)")).toBe(
			"[icon](//cdn.example.com/icon.svg)",
		);
	});

	it("preserves image titles when downgrading", () => {
		expect(
			sanitizeCommentBody('![screenshot](https://example.com/shot.png "A shot")'),
		).toBe('[screenshot](https://example.com/shot.png "A shot")');
	});

	it("downgrades obsidian embeds to internal links", () => {
		expect(sanitizeCommentBody("![[another note]]")).toBe("[[another note]]");
	});

	it("downgrades obsidian embeds with aliases to internal links", () => {
		expect(sanitizeCommentBody("![[target|display text]]")).toBe("[[target|display text]]");
	});

	it("downgrades remote html img tags to links", () => {
		expect(
			sanitizeCommentBody('<img src="https://example.com/pixel.gif" alt="pixel">'),
		).toBe("[pixel](https://example.com/pixel.gif)");
	});

	it("downgrades remote html img tags without alt text", () => {
		expect(sanitizeCommentBody('<img src="http://example.com/pixel.gif">')).toBe(
			"[image](http://example.com/pixel.gif)",
		);
	});

	it("handles several mixed constructs", () => {
		const input =
			"Local: ![local](local.png). Remote: ![r](https://x.y/z.png). Embed: ![[note|alias]].";
		expect(sanitizeCommentBody(input)).toBe(
			"Local: ![local](local.png). Remote: [r](https://x.y/z.png). Embed: [[note|alias]].",
		);
	});
});
