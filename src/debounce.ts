/** A call that runs once the caller stops asking, and can be called off. */
export interface Debounced {
	(): void;
	/** Drop a pending run. Call from onunload: a timer that fires after the
	 *  plugin is gone touches an editor that no longer belongs to it. */
	cancel(): void;
}

/**
 * Run `work` once, `delayMs` after the last call.
 *
 * Obsidian ships a `debounce` of its own; this one exists so the delay is
 * testable with fake timers without standing up the whole plugin, and so the
 * cancel path is something the unit suite can prove rather than assume.
 */
export function debounce(work: () => void, delayMs: number): Debounced {
	let timer: ReturnType<typeof setTimeout> | null = null;

	const trigger = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			work();
		}, delayMs);
	};
	trigger.cancel = (): void => {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	};
	return trigger;
}
