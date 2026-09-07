/**
 * How tall a comment body may grow before it is clipped, in pixels.
 *
 * A comment is a remark, not a document: one long enough to push every other
 * thread off the panel stops the panel being a list. Kept here rather than in
 * the stylesheet because the decision to show the control is made in code, and
 * two copies of the number would drift.
 */
export const MAX_BODY_HEIGHT = 220;

/**
 * Below this much overflow the control costs more than it saves — pressing
 * "Show more" to reveal a single extra line reads as a broken button.
 */
const MIN_OVERFLOW = 40;

/** Whether a body of this height earns a "show more" control. */
export function shouldClamp(scrollHeight: number, max: number = MAX_BODY_HEIGHT): boolean {
	return scrollHeight > max + MIN_OVERFLOW;
}
