/**
 * Levenshtein distance, abandoned once it is known to exceed `max`.
 *
 * The caller never needs the true distance of a bad candidate — only whether a
 * candidate is within tolerance — so the table is filled as a diagonal band of
 * width 2·max+1 and dropped as soon as every cell in a row is past the bound.
 * That turns the classic O(n·m) into O(n·max), which is what keeps re-anchoring
 * a long paragraph off the editor's back.
 *
 * Returns `max + 1` to mean "further than max", never the real distance.
 *
 * typescript:S3776 still reads this at 19 against a limit of 15, with the guards
 * already lifted out. The rest of the count is the band fill itself, and this is
 * the loop the timing budgets in #252 exist to watch: splitting it would put a
 * call in the innermost statement of the hottest path to satisfy a measure of
 * how the code reads. It reads as one algorithm because it is one.
 */
/**
 * The distance when it can be had without filling a table, or null.
 *
 * Two strings whose lengths differ by more than `max` cannot be within it
 * whatever they contain, and an empty string's distance is the other's length.
 * Kept out of the loop below so that function reads as the band fill it is.
 */
function withoutMeasuring(a: string, b: string, max: number): number | null {
	const beyond = max + 1;
	if (Math.abs(a.length - b.length) > max) return beyond;
	if (a.length === 0) return b.length <= max ? b.length : beyond;
	if (b.length === 0) return a.length <= max ? a.length : beyond;
	return null;
}

export function boundedLevenshtein(a: string, b: string, max: number): number {
	const beyond = max + 1;
	const trivial = withoutMeasuring(a, b, max);
	if (trivial !== null) return trivial;

	let previous = new Array<number>(b.length + 1).fill(beyond);
	for (let j = 0; j <= Math.min(b.length, max); j++) previous[j] = j;

	for (let i = 1; i <= a.length; i++) {
		const current = new Array<number>(b.length + 1).fill(beyond);
		current[0] = i <= max ? i : beyond;

		const from = Math.max(1, i - max);
		const to = Math.min(b.length, i + max);
		let bestInRow = current[0];

		for (let j = from; j <= to; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			current[j] = value > max ? beyond : value;
			if (current[j] < bestInRow) bestInRow = current[j];
		}

		// Every cell in the band is already past the bound, and distance never
		// decreases as rows are added.
		if (bestInRow > max) return beyond;
		previous = current;
	}

	return previous[b.length] > max ? beyond : previous[b.length];
}
