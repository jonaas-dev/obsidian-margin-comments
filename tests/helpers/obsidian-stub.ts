/**
 * Minimal stand-in for the `obsidian` module under test.
 *
 * The real package ships types only — no runtime — so importing it from a unit
 * test fails at resolution. vitest aliases `obsidian` here so `src/` can call the
 * real API surface while staying testable.
 */

/** Mirrors Obsidian's normalizePath: NFC, forward slashes, no duplicate or edge slashes. */
export function normalizePath(path: string): string {
	return path
		.replace(/([\\/])+/g, "/")
		.replace(/(^\/+|\/+$)/g, "")
		.normalize("NFC");
}
