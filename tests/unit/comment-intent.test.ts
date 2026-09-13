import { describe, it, expect } from "vitest";
import { commentIntent, type AnchoredThread } from "../../src/editor/comment-intent";

/**
 * Offsets in a three-line note, so the spans below are readable:
 *
 *   0        "alpha beta gamma"       [0, 16)
 *   17       "delta epsilon"          [17, 30)
 *   31       "eta theta"              [31, 40)
 */
const LINE_ONE = { from: 0, to: 16 };
const LINE_TWO = { from: 17, to: 30 };
const BETA = { id: "beta", from: 6, to: 10 };
const caret = (at: number) => ({ from: at, to: at });

describe("commentIntent", () => {
	describe("with no selection", () => {
		it("shows the thread on the line, because reading is the common intent", () => {
			expect(commentIntent([BETA], LINE_ONE, caret(0))).toEqual({
				kind: "show",
				threadIds: ["beta"],
			});
		});

		it("comments the whole line when there is none", () => {
			// from === to is how a whole-line comment is asked for: createAnchor
			// widens it to the line and marks it as one.
			expect(commentIntent([], LINE_ONE, caret(3))).toEqual({
				kind: "compose",
				from: 0,
				to: 0,
			});
		});

		it("shows every thread on the line, in document order rather than storage order (#137)", () => {
			const gamma: AnchoredThread = { id: "gamma", from: 11, to: 16 };
			expect(commentIntent([gamma, BETA], LINE_ONE, caret(0))).toEqual({
				kind: "show",
				threadIds: ["beta", "gamma"],
			});
		});
	});

	describe("with a selection on the line", () => {
		it("starts a new thread beside an existing one (#75)", () => {
			// The whole of #75: selecting other words on a commented line used to
			// open the thread that was already there, so a line could never carry
			// a second conversation.
			expect(commentIntent([BETA], LINE_ONE, { from: 11, to: 16 })).toEqual({
				kind: "compose",
				from: 11,
				to: 16,
			});
		});

		it("shows the thread whose text was selected, rather than starting a twin", () => {
			expect(commentIntent([BETA], LINE_ONE, { from: 6, to: 10 })).toEqual({
				kind: "show",
				threadIds: ["beta"],
			});
		});

		it("shows it for a selection that merely overlaps it", () => {
			expect(commentIntent([BETA], LINE_ONE, { from: 8, to: 14 })).toEqual({
				kind: "show",
				threadIds: ["beta"],
			});
		});

		it("does not count a selection that stops where the thread starts", () => {
			// Touching end to end is not overlapping. Selecting the word before a
			// commented one is a request to comment that word.
			expect(commentIntent([BETA], LINE_ONE, { from: 0, to: 6 })).toEqual({
				kind: "compose",
				from: 0,
				to: 6,
			});
		});
	});

	describe("with a selection somewhere else (#81)", () => {
		it("ignores it and comments the line that was acted on", () => {
			// The bug: the selection was used as the anchor whatever line it was
			// on, so a gutter click stored the comment against text the reader was
			// not pointing at.
			expect(commentIntent([], LINE_TWO, { from: 11, to: 16 })).toEqual({
				kind: "compose",
				from: 17,
				to: 17,
			});
		});

		it("still shows the thread on the acted-on line", () => {
			const onTwo: AnchoredThread = { id: "delta", from: 17, to: 22 };
			expect(commentIntent([BETA, onTwo], LINE_TWO, { from: 6, to: 10 })).toEqual({
				kind: "show",
				threadIds: ["delta"],
			});
		});

		it("uses a selection that reaches into the line from above", () => {
			// Deliberate: the reader selected across the boundary, and the
			// selection is what the comment is about.
			expect(commentIntent([], LINE_TWO, { from: 11, to: 22 })).toEqual({
				kind: "compose",
				from: 11,
				to: 22,
			});
		});
	});

	describe("boundaries", () => {
		it("does not claim a thread that ends where the line begins", () => {
			// Its last character is the one before the newline, so it is on the
			// line above. An inclusive test here would show the wrong thread.
			const above: AnchoredThread = { id: "above", from: 11, to: 17 };
			expect(commentIntent([above], LINE_TWO, caret(20))).toEqual({
				kind: "compose",
				from: 17,
				to: 17,
			});
		});

		it("claims a thread that starts on the line's last character", () => {
			const tail: AnchoredThread = { id: "tail", from: 15, to: 16 };
			expect(commentIntent([tail], LINE_ONE, caret(2))).toEqual({
				kind: "show",
				threadIds: ["tail"],
			});
		});

		it("claims a whole-line thread on an empty line", () => {
			// An empty line's span is zero-length, and so is the anchor of a
			// comment made on it. Neither overlaps anything under a strict test.
			const empty = { from: 41, to: 41 };
			const onEmpty: AnchoredThread = { id: "empty", from: 41, to: 41 };
			expect(commentIntent([onEmpty], empty, caret(41))).toEqual({
				kind: "show",
				threadIds: ["empty"],
			});
		});

		it("ignores a zero-length selection however it is placed", () => {
			// A caret is not a selection, even sitting inside a thread's text.
			expect(commentIntent([], LINE_ONE, caret(8))).toEqual({
				kind: "compose",
				from: 0,
				to: 0,
			});
		});
	});
});
