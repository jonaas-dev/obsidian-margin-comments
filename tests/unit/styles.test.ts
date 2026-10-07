import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("styles.css", "utf8");

/** The stylesheet with comments removed, so prose about colours is not audited. */
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * At-rule preludes are neither selectors nor declarations, and read as both:
 * `@media (prefers-reduced-motion: reduce)` looks exactly like a property.
 */
const rules = stripped.replace(/@[a-z-]+[^{]*\{/g, "\n{");

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNCTIONAL = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
/**
 * Only the names anyone reaches for by accident. The full CSS name list contains
 * words that appear in perfectly good values, and a list that flags those trains
 * people to ignore this test.
 */
const NAMED =
	/\b(black|white|red|green|blue|yellow|orange|purple|pink|brown|cyan|magenta|gray|grey|silver|gold|navy|teal|olive|maroon|lime|aqua|fuchsia|rebeccapurple)\b/;

/**
 * Properties allowed to carry a literal colour.
 *
 * A mask gradient is an alpha ramp, not a colour: the channel values are
 * discarded and only the alpha reaches the compositor, so `black` there means
 * "opaque" and could not follow the theme even if it wanted to.
 */
const EXEMPT = /^(-webkit-)?mask(-image)?$/;

interface Declaration {
	line: number;
	property: string;
	value: string;
}

/**
 * Every declaration in the sheet, wherever it sits on a line.
 *
 * Scanned rather than read line by line: an anchored per-line pattern misses
 * `.a { color: #f00; }` written on one line, which is the shape a hurried edit
 * takes. The first version of this test did exactly that and passed against a
 * stylesheet with three deliberate violations in it.
 */
function parseDeclarations(source: string): Declaration[] {
	const out: Declaration[] = [];
	for (const match of source.matchAll(/([-a-zA-Z]+)\s*:\s*([^;{}]+)[;}]/g)) {
		out.push({
			line: source.slice(0, match.index).split("\n").length,
			property: match[1],
			value: match[2].trim(),
		});
	}
	return out;
}

/**
 * Every colour must come from Obsidian's variables, or the plugin looks right
 * only in the theme it was written against. This is what makes that stick: a
 * hardcoded colour is indistinguishable from a correct one in that theme.
 */
describe("styles.css theme awareness", () => {
	const parsed = parseDeclarations(rules);

	it("reads declarations wherever they sit on a line", () => {
		// The blind spot that made the first version of this file useless.
		const sample = parseDeclarations(".a { color: #ff0000; }\n.b {\n\tcolor: red;\n}");
		expect(sample).toEqual([
			{ line: 1, property: "color", value: "#ff0000" },
			{ line: 3, property: "color", value: "red" },
		]);
	});

	it("parses the stylesheet it is auditing", () => {
		// Without this, a parser that matched nothing would report a clean sheet.
		expect(parsed.length).toBeGreaterThan(200);
		expect(parsed.some((d) => d.property === "color" && d.value.includes("var(--"))).toBe(true);
	});

	it("takes every colour from a variable", () => {
		const offenders = parsed
			.filter((d) => !EXEMPT.test(d.property))
			.filter((d) => HEX.test(d.value) || FUNCTIONAL.test(d.value) || NAMED.test(d.value))
			.map((d) => `styles.css:${d.line}  ${d.property}: ${d.value}`);
		expect(offenders).toEqual([]);
	});

	it("keeps every color-mix behind @supports, with a fallback before it", () => {
		// The mechanism used to be two `background-color` declarations in a row,
		// relying on a renderer dropping the one it cannot parse. The community
		// directory's CSS review reads that as seven duplicated properties, which
		// it also is (#336), so the condition is now stated rather than implied.
		//
		// What has to hold is the pairing, and it is checked here because nothing
		// else can see it: a selector inside @supports with no plain declaration
		// earlier in the file paints nothing at all on a renderer without
		// color-mix — which is every mobile webview before iOS 16.2.
		const supports = /@supports \(background-color: color-mix\([^)]*\)[^)]*\)\s*\{/.exec(
			stripped,
		);
		expect(supports).not.toBeNull();
		const blockStart = supports!.index;
		const before = stripped.slice(0, blockStart);
		// Past the prelude, which contains a color-mix of its own — the probe the
		// condition tests with — and would otherwise read as a selector.
		const inside = stripped.slice(blockStart + supports![0].length);

		// Nothing mixes outside the block: a stray color-mix in an ordinary rule
		// would be the regression this guards, and it would be invisible on the
		// machine of whoever wrote it.
		expect({ mixesOutsideTheBlock: before.includes("color-mix") }).toEqual({
			mixesOutsideTheBlock: false,
		});

		const mixed = [...inside.matchAll(/([^{}@;]+)\{([^}]*color-mix[^}]*)\}/g)].map((match) => ({
			selector: match[1].trim(),
			body: match[2],
		}));
		expect(mixed.length).toBeGreaterThanOrEqual(7);

		const unpaired = mixed
			.filter((rule) => {
				const earlier = new RegExp(
					`${rule.selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*background-color\\s*:`,
				);
				return !earlier.test(before);
			})
			.map((rule) => rule.selector);
		expect(unpaired).toEqual([]);
	});

	it("roots every selector in the plugin's own namespace", () => {
		// Obsidian loads every plugin's stylesheet into one document, so a rule
		// that does not start from one of our classes reaches other plugins' DOM
		// and Obsidian's own. Descendants and modifiers are fine —
		// `.inline-comment-quote-icon .svg-icon` and `.inline-comment-filter
		// .is-active` both start from us — but a bare `.is-active` does not.
		const selectors = [...rules.matchAll(/([^{}@;]+)\{/g)]
			.flatMap((match) => match[1].split(","))
			.map((selector) => selector.trim())
			.filter((selector) => selector !== "");

		const unrooted = selectors.filter((selector) => {
			const first = selector.split(/[\s>+~]+/)[0];
			return !first.split(/(?=[.:#[])/).some((part) => part.startsWith(".inline-comment"));
		});
		expect(unrooted).toEqual([]);
	});
});
