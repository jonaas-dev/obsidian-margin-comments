import { describe, it, expect } from "vitest";
import { displayQuote } from "../../src/ui/quote-text";

describe("displayQuote", () => {
	it("quotes the example from #128 without its asterisks", () => {
		expect(
			displayQuote(
				"A second paragraph with **bold words** in it, and then some plain text after them.",
			),
		).toBe("A second paragraph with bold words in it, and then some plain text after them.");
	});

	it("takes out strong, emphasis, strikethrough and highlight markers", () => {
		expect(displayQuote("**strong** __strong__ *em* _em_ ~~gone~~ ==marked==")).toBe(
			"strong strong em em gone marked",
		);
	});

	it("keeps a wikilink's alias, or its target when there is none", () => {
		expect(displayQuote("see [[Target note|the target]] and [[Other note]]")).toBe(
			"see the target and Other note",
		);
	});

	it("keeps an embed's name and a Markdown link's text", () => {
		expect(displayQuote("![[diagram.png]] and [the docs](https://example.com)")).toBe(
			"diagram.png and the docs",
		);
	});

	it("keeps the content of a code span verbatim, asterisks included", () => {
		expect(displayQuote("run `a*b*c` now")).toBe("run a*b*c now");
	});

	it("leaves a lone asterisk and underscores inside a word alone", () => {
		expect(displayQuote("2 * 3 = 6 in snake_case_name")).toBe("2 * 3 = 6 in snake_case_name");
	});

	it("only closes emphasis on a marker that follows text, not one after a space", () => {
		expect(displayQuote("**open ** still open**")).toBe("open ** still open");
		expect(displayQuote("~~a ~~")).toBe("~~a ~~");
		expect(displayQuote("==a ==b==")).toBe("a ==b");
		expect(displayQuote("*a *b*")).toBe("*a b");
		expect(displayQuote("_a _")).toBe("_a _");
		expect(displayQuote("**x**")).toBe("x");
		expect(displayQuote("*x*")).toBe("x");
	});

	it("drops heading, quote, task, bullet and numbered prefixes", () => {
		expect(displayQuote("## Heading")).toBe("Heading");
		expect(displayQuote("> quoted")).toBe("quoted");
		expect(displayQuote("- [ ] a task")).toBe("a task");
		expect(displayQuote("- a bullet")).toBe("a bullet");
		expect(displayQuote("3. a numbered item")).toBe("a numbered item");
	});

	it("falls back to the source when syntax is all there is", () => {
		expect(displayQuote("- ")).toBe("- ");
	});

	it("returns plain text unchanged", () => {
		expect(displayQuote("nothing to take out here")).toBe("nothing to take out here");
	});

	describe("table rows (#422)", () => {
		it("shows a row as its cells joined with a middle dot", () => {
			expect(displayQuote("| Beta | pending | second row |")).toBe(
				"Beta · pending · second row",
			);
		});

		it("keeps an escaped pipe inside its cell", () => {
			expect(displayQuote("| a \\| b | c |")).toBe("a | b · c");
		});

		it("drops a delimiter row", () => {
			expect(displayQuote("|---|:--:|")).toBe("|---|:--:|");
			expect(displayQuote("| H | I |\n|---|:--:|\n| a | b |")).toBe("H · I\na · b");
		});

		it("handles a multi-row selection", () => {
			expect(displayQuote("| a | b |\n| c | d |")).toBe("a · b\nc · d");
		});

		it("leaves a pipe in prose alone", () => {
			expect(displayQuote("either this | or that")).toBe("either this | or that");
			expect(displayQuote("|")).toBe("|");
		});
	});
});
