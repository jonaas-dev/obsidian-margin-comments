/**
 * Sanitize a comment body before it is rendered.
 *
 * Comment bodies are Markdown stored in sidecar files, so whoever can write
 * those files can put anything in them. In a shared vault that is not the same
 * trust boundary as the user's own notes. We still render Markdown, but we
 * downgrade constructs that silently load remote resources or pull in other
 * notes:
 *
 * - Remote images (`![](https://…)`) become plain links.
 * - Obsidian embeds (`![[another note]]`) become regular internal links.
 * - Remote `<img>` tags become plain links.
 *
 * Local images (`![alt](local.png)`) are left alone: they resolve against the
 * vault and do not phone home.
 */
export function sanitizeCommentBody(body: string): string {
	let sanitized = body;

	// Markdown images that point at a remote URL. The `!` prefix tells the
	// renderer to load and display the resource; removing it leaves a link the
	// user can still choose to follow.
	sanitized = sanitized.replace(
		/!\[([^\]]*)\]\(\s*((?:https?:\/\/|\/\/)[^)\s]+)(?:\s+"([^"]*)")?\s*\)/gi,
		(_match, alt, url, title) => {
			const cleanAlt = alt.trim() || "image";
			return title
				? `[${cleanAlt}](${url} "${title}")`
				: `[${cleanAlt}](${url})`;
		},
	);

	// Obsidian embeds render the target note inline. In a comment card that is
	// the same as silently opening a note the user did not ask to read, so keep
	// the link but drop the leading `!`.
	sanitized = sanitized.replace(/!\[\[([^\]]+)\]\]/g, "[[$1]]");

	// Remote HTML img tags. Obsidian already sanitises dangerous HTML, but it
	// lets images through. Convert them to links so no request is made until the
	// user clicks.
	sanitized = sanitized.replace(
		/<img\b[^>]*\bsrc\s*=\s*["']((?:https?:\/\/|\/\/)[^"']+)["'][^>]*>/gi,
		(match) => {
			const srcMatch = match.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
			const altMatch = match.match(/\balt\s*=\s*["']([^"]*)["']/i);
			const alt = altMatch ? altMatch[1].trim() : "image";
			const src = srcMatch ? srcMatch[1].trim() : "";
			return `[${alt || "image"}](${src})`;
		},
	);

	return sanitized;
}
