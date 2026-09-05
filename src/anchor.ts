import type { TextAnchor } from "./types";
import { hashString } from "./utils";

/** Characters of surrounding text kept on each side of an anchor. */
export const CONTEXT_LENGTH = 50;

export type MatchMethod = "hash" | "context" | "fuzzy";

export interface AnchorMatch {
	from: number;
	to: number;
	/** The text occurs more than once; the caller may want to warn. */
	ambiguous: boolean;
	method: MatchMethod;
}

/** 1-based line number containing `offset`. */
function lineNumberAt(doc: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < doc.length; i++) {
		if (doc[i] === "\n") line++;
	}
	return line;
}

function lineRangeAt(doc: string, offset: number): { from: number; to: number } {
	const from = doc.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const nextBreak = doc.indexOf("\n", offset);
	return { from, to: nextBreak === -1 ? doc.length : nextBreak };
}

/**
 * Build an anchor for a selection, or for the whole line when `from === to`.
 *
 * Position fields are advisory: they narrow the search later but are never the
 * sole source of truth, so a comment survives edits above it.
 */
export function createAnchor(doc: string, from: number, to: number): TextAnchor {
	const isLineComment = from === to;
	const range = isLineComment ? lineRangeAt(doc, from) : { from, to };
	const selectedText = doc.slice(range.from, range.to);
	const line = lineRangeAt(doc, range.from);

	return {
		selectedText,
		textHash: hashString(selectedText),
		isLineComment,
		contextBefore: doc.slice(Math.max(0, range.from - CONTEXT_LENGTH), range.from),
		contextAfter: doc.slice(range.to, range.to + CONTEXT_LENGTH),
		lineHint: lineNumberAt(doc, range.from),
		startOffset: range.from - line.from,
		endOffset: line.to - range.to,
	};
}

/** Every offset in `doc` where `needle` occurs. */
function occurrences(doc: string, needle: string): number[] {
	if (needle === "") return [];
	const found: number[] = [];
	for (let i = doc.indexOf(needle); i !== -1; i = doc.indexOf(needle, i + 1)) {
		found.push(i);
	}
	return found;
}

/**
 * Stage 1: locate the anchor by exact content.
 *
 * Content rather than position is what makes a comment survive the note being
 * reorganised. The line hint only breaks ties between repeated occurrences.
 */
export function matchByHash(doc: string, anchor: TextAnchor): AnchorMatch | null {
	const { selectedText } = anchor;
	if (selectedText === "" || hashString(selectedText) !== anchor.textHash) return null;

	const found = occurrences(doc, selectedText);
	if (found.length === 0) return null;

	const nearest = found.reduce((best, offset) =>
		Math.abs(lineNumberAt(doc, offset) - anchor.lineHint) <
		Math.abs(lineNumberAt(doc, best) - anchor.lineHint)
			? offset
			: best,
	);

	return {
		from: nearest,
		to: nearest + selectedText.length,
		ambiguous: found.length > 1,
		method: "hash",
	};
}

/** Longest common suffix length of `a` and `b`, capped at both lengths. */
function commonSuffix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

/** Longest common prefix length of `a` and `b`. */
function commonPrefix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/** Fraction of the stored context that still matches, 0 to 1. */
const CONTEXT_MATCH_RATIO = 0.6;
/** Below this many characters, context is too weak to identify anything. */
const MIN_CONTEXT_CHARS = 8;

/**
 * Stage 2: the commented text itself was edited, but its surroundings survived.
 *
 * Both sides must agree. Anchoring on one side alone would place the comment on
 * whatever text happens to sit next to the surviving half, which is worse than
 * reporting the anchor as lost.
 */
export function matchByContext(doc: string, anchor: TextAnchor): AnchorMatch | null {
	const { contextBefore, contextAfter } = anchor;
	if (contextBefore.length < MIN_CONTEXT_CHARS || contextAfter.length < MIN_CONTEXT_CHARS) {
		return null;
	}

	let best: { from: number; to: number; score: number } | null = null;

	for (let start = 0; start <= doc.length; start++) {
		const beforeScore = commonSuffix(doc.slice(0, start), contextBefore) / contextBefore.length;
		if (beforeScore < CONTEXT_MATCH_RATIO) continue;

		for (let end = start; end <= doc.length; end++) {
			const afterScore = commonPrefix(doc.slice(end), contextAfter) / contextAfter.length;
			if (afterScore < CONTEXT_MATCH_RATIO) continue;

			const score = beforeScore + afterScore;
			if (!best || score > best.score) best = { from: start, to: end, score };
			break; // the first end that clears the bar is the tightest span
		}
	}

	return best ? { from: best.from, to: best.to, ambiguous: false, method: "context" } : null;
}
