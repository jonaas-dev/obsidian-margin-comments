import { describe, it, expect } from "vitest";
import { documentLanguage, emptyLineLabel } from "../../src/ui/labels";

describe("documentLanguage", () => {
	it("narrows a regional tag to its language", () => {
		// These strings do not differ by region, and pt-BR must not fall back to
		// English just because it carries one.
		expect(documentLanguage("pt-BR")).toBe("pt");
		expect(documentLanguage("en-GB")).toBe("en");
	});

	it("tolerates the shapes an absent language arrives in", () => {
		expect(documentLanguage(null)).toBe("");
		expect(documentLanguage(undefined)).toBe("");
		expect(documentLanguage("  ")).toBe("");
		expect(documentLanguage("ES")).toBe("es");
	});
});

describe("emptyLineLabel", () => {
	it("speaks the reader's language where it can", () => {
		// It stands in for the reader's own text inside their own note, so
		// English there reads as content that arrived by mistake.
		expect(emptyLineLabel("es")).toBe("Línea vacía");
		expect(emptyLineLabel("ca")).toBe("Línia buida");
		expect(emptyLineLabel("pt-BR")).toBe("Linha vazia");
	});

	it("falls back to English rather than guessing", () => {
		// A language the list does not cover, and no language at all, land in
		// the same place — which is the point of the fallback.
		expect(emptyLineLabel("ja")).toBe("Empty line");
		expect(emptyLineLabel(null)).toBe("Empty line");
	});

	it("never answers with an empty string, which is the bug it exists for", () => {
		for (const lang of ["es", "ja", "", null, "xx-YY"]) {
			expect(emptyLineLabel(lang).length).toBeGreaterThan(0);
		}
	});
});
