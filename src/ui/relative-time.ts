const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

function plural(value: number, unit: string): string {
	return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

/** Human-readable age, falling back to an absolute date once it stops helping. */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
	const elapsed = now - timestamp;
	if (elapsed < MINUTE) return "just now";
	if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "minute");
	if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
	if (elapsed < MONTH) return plural(Math.floor(elapsed / DAY), "day");
	return new Date(timestamp).toLocaleDateString();
}
