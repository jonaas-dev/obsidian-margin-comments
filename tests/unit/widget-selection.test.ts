import { describe, it, expect } from "vitest";
import { widgetSelection } from "../../src/editor/widget-selection";

const SOURCE = "> [!note] Title\n> Callout body sentence.";
const RENDERED = "Title\nCallout body sentence.";

/** Select the `nth` appearance of `word` in the rendered text. */
function pick(source: string, rendered: string, word: string, nth = 0) {
	let at = -1;
	for (let i = 0; i <= nth; i++) at = rendered.indexOf(word, at + 1);
	return widgetSelection(source, rendered, rendered.slice(0, at), word);
}

describe("widgetSelection", () => {
	it("maps a plain word to its place in the source", () => {
		const range = pick(SOURCE, RENDERED, "body")!;
		expect(SOURCE.slice(range.from, range.to)).toBe("body");
	});

	it("tells the appearances of a repeated word apart", () => {
		const source = "> one two one three one";
		const rendered = "one two one three one";
		for (const nth of [0, 1, 2]) {
			const range = pick(source, rendered, "one", nth)!;
			expect(range.from).toBe(source.indexOf("one", nth === 0 ? 0 : nth === 1 ? 7 : 19));
		}
	});

	it("maps words after inline Markdown, and inside a link's text", () => {
		const source = "> **Bold** and [a link](https://x.y) then more";
		const rendered = "Bold and a link then more";
		const after = pick(source, rendered, "then more")!;
		expect(source.slice(after.from, after.to)).toBe("then more");
		const link = pick(source, rendered, "a link")!;
		expect(source.slice(link.from, link.to)).toBe("a link");
	});

	it("answers null for text that spans consumed Markdown", () => {
		expect(pick("> **Bold** word", "Bold word", "Bold word")).toBeNull();
	});

	it("answers null for text the source does not hold", () => {
		expect(widgetSelection(SOURCE, RENDERED, "", "absent")).toBeNull();
	});

	it("answers null when the source repeats the words more than the rendering does", () => {
		const source = "> see [cat](cat) here";
		expect(pick(source, "see cat here", "cat")).toBeNull();
	});
});
