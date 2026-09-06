export type Direction = "next" | "previous";

/**
 * The commented line to jump to from `from`, or null when there is none.
 *
 * Strictly past the cursor, so repeating the command walks the note instead of
 * landing on the same comment twice. It wraps: without that the last comment is
 * a dead end, and pressing the key again does nothing, which reads as the
 * command being broken rather than as the end of the note.
 */
export function findAdjacentLine(lines: number[], from: number, direction: Direction): number | null {
	if (lines.length === 0) return null;

	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	if (direction === "next") {
		return sorted.find((line) => line > from) ?? sorted[0];
	}
	return [...sorted].reverse().find((line) => line < from) ?? sorted[sorted.length - 1];
}
