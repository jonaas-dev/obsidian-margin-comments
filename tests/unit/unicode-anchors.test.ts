import { describe, it, expect } from "vitest";
import { matchAnchor, CONTEXT_LENGTH } from "../../src/anchor";
import { hashString } from "../../src/utils";
import type { TextAnchor } from "../../src/types";

/**
 * Anchors over text the offset arithmetic could mis-measure.
 *
 * Every offset in this plugin is a UTF-16 code unit: the editor's, the stored
 * anchor's, and `splitText`'s in reading mode. An emoji is two of them and reads
 * as one character; a combining sequence is two and draws as one. The audit of
 * 2026-10-07 found no coverage of either, so this pins what actually happens —
 * including the one case that does not work, which is #320.
 */

const options = { fuzzy: true, threshold: 0.3 };

function anchorFor(doc: string, start: number, end: number): TextAnchor {
	const selectedText = doc.slice(start, end);
	return {
		selectedText,
		textHash: hashString(selectedText),
		isLineComment: false,
		contextBefore: doc.slice(Math.max(0, start - CONTEXT_LENGTH), start),
		contextAfter: doc.slice(end, end + CONTEXT_LENGTH),
		lineHint: doc.slice(0, start).split("\n").length,
		startOffset: start,
		endOffset: end,
	};
}

describe("anchors over astral and combining text", () => {
	const rockets = "Deploy 🚀🚀 the rocket today";

	it("matches a selection that covers whole emoji", () => {
		const at = rockets.indexOf("🚀🚀");
		const match = matchAnchor(rockets, anchorFor(rockets, at, at + 4), options);
		expect(match && rockets.slice(match.from, match.to)).toBe("🚀🚀");
	});

	it("matches a selection cut between the halves of one", () => {
		// Not reachable from the editor, which selects by grapheme. It is reachable
		// from a hand-edited sidecar, and the answer must be a match or a refusal
		// rather than an exception.
		const at = rockets.indexOf("🚀🚀");
		const match = matchAnchor(rockets, anchorFor(rockets, at, at + 3), options);
		expect(match && rockets.slice(match.from, match.to)).toBe(rockets.slice(at, at + 3));
	});

	it("matches a combining sequence as it is written", () => {
		const doc = "Café au lait is combining, cafe is not";
		const match = matchAnchor(doc, anchorFor(doc, 0, 5), options);
		expect(match && doc.slice(match.from, match.to)).toBe("Café");
	});

	describe("when the document changes Unicode normal form (#320)", () => {
		const nfd = "Cafe\u0301 au lait and more text for the context to hold on to";
		const nfc = nfd.normalize("NFC");

		it("still matches the word it was written on", () => {
			expect(matchAnchor(nfd, anchorFor(nfd, 0, 5), options)?.method).toBe("hash");
		});

		it("follows an NFD anchor into an NFC document", () => {
			// The defect this was filed for: routine on macOS and through several
			// sync clients, and it orphaned every comment on an accented word at
			// the default tolerance.
			const match = matchAnchor(nfc, anchorFor(nfd, 0, 5), options);
			expect(match && nfc.slice(match.from, match.to)).toBe("Caf\u00e9");
		});

		it("follows an NFC anchor into an NFD document", () => {
			// The other direction is just as real: a phone writes NFC into a vault
			// a Mac has been writing NFD into.
			const match = matchAnchor(nfd, anchorFor(nfc, 0, 4), options);
			expect(match && nfd.slice(match.from, match.to)).toBe("Cafe\u0301");
		});

		it("returns offsets into the document as stored, not a normalised copy", () => {
			// Why the anchor is renormalised and the document is not. NFC is shorter
			// here, so an offset taken from a normalised copy would point into the
			// wrong place, and the text it addressed would be quietly off by one.
			expect(nfd.length).not.toBe(nfc.length);
			expect(matchAnchor(nfd, anchorFor(nfc, 0, 4), options)?.to).toBe(5);
		});

		it("does not confuse an accented word with its unaccented twin", () => {
			// The retry must not become a looser search: Caf\u00e9 and Cafe are
			// different words, and normalisation is no licence to mix them.
			const plain = "Cafe au lait and more text for the context to hold on to";
			expect(matchAnchor(plain, anchorFor(nfd, 0, 5), { fuzzy: false })).toBeNull();
		});
	});

	it("keys distinct sidecars for paths that differ only by emoji", () => {
		const a = hashString("ex 🚀 plore.md");
		const b = hashString("ex 🛸 plore.md");
		expect(a).not.toBe(b);
		// The hash becomes a filename, so it has to stay filename-safe.
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("picks the occurrence its context names, not the first", () => {
		const doc = "alpha target omega\nbeta target gamma";
		const second = doc.lastIndexOf("target");
		expect(matchAnchor(doc, anchorFor(doc, second, second + 6), options)?.from).toBe(second);
	});

	it("still picks it after a line is inserted above", () => {
		const doc = "alpha target omega\nbeta target gamma";
		const second = doc.lastIndexOf("target");
		const anchor = anchorFor(doc, second, second + 6);
		const edited = `A new first line\n${doc}`;
		expect(matchAnchor(edited, anchor, options)?.from).toBe(edited.lastIndexOf("target"));
	});

	it("refuses rather than guesses when the text is replaced outright", () => {
		const doc = "The quick brown fox jumps over the lazy dog near the river bank today.";
		const anchor = anchorFor(doc, 4, 25);
		const replaced = "Completely different sentence with nothing shared whatsoever here.";
		expect(matchAnchor(replaced, anchor, options)).toBeNull();
	});
});
