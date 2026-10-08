/** A call that runs once the caller stops asking, and can be called off. */
export interface Debounced {
	(): void;
	/** Drop a pending run. Call from onunload: a timer that fires after the
	 *  plugin is gone touches an editor that no longer belongs to it. */
	cancel(): void;
}

/** The part of a window this needs, so a test can supply one without a browser. */
export interface Timers {
	setTimeout(handler: () => void, timeout: number): number;
	clearTimeout(id: number): void;
}

/**
 * Run `work` once, `delayMs` after the last call.
 *
 * Obsidian ships a `debounce` of its own; this one exists so the delay is
 * testable with fake timers without standing up the whole plugin, and so the
 * cancel path is something the unit suite can prove rather than assume.
 *
 * The timers are passed in rather than reached for. A bare `setTimeout` is the
 * main window's, which is what `prefer-window-timers` warns about and what the
 * directory review flagged; writing `window.setTimeout` would clear the warning
 * and take the module's reason to exist with it, because the unit suite runs in
 * node, where there is no `window` — it was tried, and six tests went red.
 * Injecting satisfies both: the plugin hands over the window it belongs to, and
 * a test hands over a stub (#336).
 */
export function debounce(work: () => void, delayMs: number, timers: Timers): Debounced {
	let timer: number | null = null;

	const trigger = (): void => {
		if (timer !== null) timers.clearTimeout(timer);
		timer = timers.setTimeout(() => {
			timer = null;
			work();
		}, delayMs);
	};
	trigger.cancel = (): void => {
		if (timer === null) return;
		timers.clearTimeout(timer);
		timer = null;
	};
	return trigger;
}
