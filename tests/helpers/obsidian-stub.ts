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

/** No-op stand-in: icon rendering has no observable behaviour in a unit test. */
export function setIcon(_el: HTMLElement, _iconId: string): void {
	/* intentionally empty */
}

/**
 * Every message a Notice was raised with since `clearNotices`.
 *
 * Notices are the only trace a failed write leaves for the reader (#266), so a
 * test that cannot read them cannot tell "reported" from "swallowed".
 */
export const noticeMessages: string[] = [];

export function clearNotices(): void {
	noticeMessages.length = 0;
}

/** Records its message instead of drawing: there is no Obsidian here to draw into. */
export class Notice {
	constructor(readonly message: string) {
		noticeMessages.push(message);
	}

	hide(): void {
		/* intentionally empty */
	}
}

/** The shape `instanceof` checks in src/ rely on; Obsidian's own carry far more. */
export class TAbstractFile {
	constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
	get extension(): string {
		const name = this.path.split("/").pop() ?? "";
		const dot = name.lastIndexOf(".");
		return dot === -1 ? "" : name.slice(dot + 1);
	}

	get basename(): string {
		const name = this.path.split("/").pop() ?? "";
		const dot = name.lastIndexOf(".");
		return dot === -1 ? name : name.slice(0, dot);
	}
}

export class TFolder extends TAbstractFile {}
