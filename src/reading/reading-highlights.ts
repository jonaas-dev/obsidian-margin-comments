import type { Thread } from "../threads";

/** A stretch of a block's rendered text that carries an open thread. */
export interface ReadingHighlight {
	/** Thread root id, so the mark can be traced back to its conversation. */
	id: string;
	/**
	 * The commented text as the *current* document has it, not as it was stored.
	 * Reading mode renders the document as it stands, so a comment that moved
	 * through the fuzzy stage has to be looked for where it landed.
	 */
	text: string;
	/**
	 * How many times the same words appear earlier in the block's source. A
	 * block can repeat them, as a list of "Numbered one" and "Numbered two"
	 * does, and the first match in the rendered text is not always the one
	 * that was commented (#175).
	 */
	occurrence: number;
}

/** Where a needle falls inside one segment of a run of text. */
export interface TextSlice {
	index: number;
	start: number;
	end: number;
}

interface SourcePosition {
	index: number;
	offset: number;
}

/**
 * Open threads anchored inside a block of the note, in document order.
 *
 * `lineStart` and `lineEnd` are 0-based and inclusive, as Obsidian's
 * `getSectionInfo` reports them; `Thread.line` is 1-based.
 *
 * Whole-line comments come back with empty text on purpose: there is no
 * selection to find in the rendered output, and the caller falls back to
 * marking the block rather than guessing at a range.
 */
export function highlightsInBlock(
	doc: string,
	threads: Thread[],
	lineStart: number,
	lineEnd: number,
): ReadingHighlight[] {
	const blockStart = offsetOfLine(doc, lineStart);
	return threads
		.filter(
			(thread) =>
				!thread.orphaned &&
				!thread.root.resolved &&
				thread.line !== null &&
				thread.line - 1 >= lineStart &&
				thread.line - 1 <= lineEnd,
		)
		.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
		.map((thread) => {
			const text =
				thread.root.anchor.isLineComment || thread.position === null || thread.end === null
					? ""
					: doc.slice(thread.position, thread.end);
			return {
				id: thread.root.id,
				text,
				occurrence:
					text === "" ? 0 : appearances(doc.slice(blockStart, thread.position!), text),
			};
		});
}

/** Offset of the start of a 0-based line, or the end of the document past its last line. */
function offsetOfLine(doc: string, line: number): number {
	let offset = 0;
	for (let passed = 0; passed < line; passed++) {
		const next = doc.indexOf("\n", offset);
		if (next === -1) return doc.length;
		offset = next + 1;
	}
	return offset;
}

/**
 * Appearances of `needle` in `text`, compared and counted as
 * `locateAcrossSegments` compares and counts them, overlaps included, so that
 * the nth appearance in the source is the nth it looks for.
 */
function appearances(text: string, needle: string): number {
	const wanted = normalise([needle]).text;
	const haystack = normalise([text]).text;
	let count = 0;
	for (let at = haystack.indexOf(wanted); at !== -1; at = haystack.indexOf(wanted, at + 1))
		count++;
	return count;
}

/**
 * Collapse whitespace, remembering where every surviving character came from.
 *
 * The rendered output is not the source: a soft-wrapped sentence arrives as one
 * run of text with the newline turned into a space, and an indented list item
 * loses its indent. Comparing the two literally fails on text that is plainly
 * the same, so both sides are normalised and the map is what turns a hit in the
 * normalised string back into a range in the real nodes.
 */
function normalise(segments: string[]): {
	text: string;
	starts: SourcePosition[];
	ends: SourcePosition[];
} {
	let text = "";
	const starts: SourcePosition[] = [];
	const ends: SourcePosition[] = [];
	let spaceStart: SourcePosition | null = null;
	let spaceEnd: SourcePosition | null = null;

	/**
	 * Emit the run of whitespace just walked past as the single space it collapses
	 * to. Leading whitespace is dropped rather than emitted: a match must not begin
	 * on space the renderer collapsed away.
	 */
	const flushSpace = (): void => {
		if (spaceStart === null) return;
		if (text.length > 0 && spaceEnd !== null) {
			text += " ";
			starts.push(spaceStart);
			ends.push(spaceEnd);
		}
		spaceStart = null;
		spaceEnd = null;
	};

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		for (let offset = 0; offset < segment.length; offset++) {
			if (/\s/.test(segment[offset])) {
				if (spaceStart === null) spaceStart = { index, offset };
				spaceEnd = { index, offset: offset + 1 };
				continue;
			}
			flushSpace();
			text += segment[offset];
			starts.push({ index, offset });
			ends.push({ index, offset: offset + 1 });
		}
	}

	return { text, starts, ends };
}

/**
 * Where the `occurrence`-th appearance of `needle`, counted from 0, falls across
 * `segments`, or null if it is not there.
 *
 * Not being there is expected, not a failure: the anchor may include Markdown
 * the renderer consumed — `**bold**` arrives as `bold` — and the caller marks
 * the whole block instead.
 */
export function locateAcrossSegments(
	segments: string[],
	needle: string,
	occurrence = 0,
): TextSlice[] | null {
	const wanted = normalise([needle]).text;
	if (wanted === "") return null;

	const haystack = normalise(segments);
	let at = haystack.text.indexOf(wanted);
	// Fewer appearances here than in the source means the renderer consumed one,
	// and marking another would be a guess: the caller marks the block instead.
	for (let skipped = 0; skipped < occurrence && at !== -1; skipped++) {
		at = haystack.text.indexOf(wanted, at + 1);
	}
	if (at === -1) return null;

	const start = haystack.starts[at];
	const end = haystack.ends[at + wanted.length - 1];

	const slices: TextSlice[] = [];
	for (let index = start.index; index <= end.index; index++) {
		const from = index === start.index ? start.offset : 0;
		const to = index === end.index ? end.offset : segments[index].length;
		if (to > from) slices.push({ index, start: from, end: to });
	}
	return slices;
}
