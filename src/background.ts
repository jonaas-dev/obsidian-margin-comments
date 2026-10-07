/**
 * Work nobody is waiting for, which still has to say when it fails.
 *
 * Eighteen promises in this plugin were started with a bare `void`, and the
 * pattern was applied inconsistently rather than missing: where a failure clearly
 * mattered — saving a comment — it was caught and reported, and everywhere else
 * a rejection went nowhere at all. The common failures are already absorbed
 * deeper down (`getCommentsForFile` warns and carries on), so this is about the
 * uncommon one, which is the one worth a line in the console when somebody
 * reports that clicking a marker does nothing (#317).
 *
 * `what` is read by a person looking at a console, so it names the attempt and
 * not the function: "open a thread from its marker", not "showExistingOrCompose".
 */
export function inBackground(what: string, work: Promise<unknown>): void {
	void work.catch((error: unknown) => {
		console.error(`margin-comments: could not ${what}`, error);
	});
}
