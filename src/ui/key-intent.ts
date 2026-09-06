export type KeyIntent = "submit" | "newline" | "cancel" | "ignore";

/**
 * What a keystroke means inside a comment field.
 *
 * Enter sends and Shift+Enter breaks the line, in every field rather than only
 * the short reply one: a single rule is easier to hold than a convention that
 * changes per box. Cmd/Ctrl+Enter keeps working because it is the habit people
 * arrive with from every other comment box.
 *
 * Extracted from the DOM handler so the decision can be tested: the automated
 * harness cannot hold focus in a textarea, so a keydown never reaches it there.
 */
export function keyIntent(event: KeyboardEvent): KeyIntent {
	if (event.key === "Escape") return "cancel";
	if (event.key !== "Enter") return "ignore";
	if (event.metaKey || event.ctrlKey) return "submit";
	if (event.shiftKey || event.altKey) return "newline";
	return "submit";
}
