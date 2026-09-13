/**
 * Sanitize a comment body before it reaches MarkdownRenderer.
 *
 * Comment bodies are user-provided Markdown, and they travel with the vault via
 * Git and file sync. Rendering them with the same pipeline Obsidian uses for notes
 * would load remote resources and resolve embedded notes automatically, which turns
 * a comment into a read receipt or a way to pull in content from elsewhere. This
 * preprocessor keeps formatting (bold, lists, internal links) but blocks:
 *
 * - remote images (`![](https://…)`)
 * - HTML images (`<img src="https://…">`)
 * - note embeds (`![[Another note]]`)
 *
 * Embeds are downgraded to ordinary internal links; remote images become plain
 * links so the reader can still choose to open them.
 */
export function sanitizeCommentBody(source: string): string {
	return (
		source
			// Note embeds: ![[Target]] -> [[Target]] (link, not embedded content).
			.replace(/!\[\[([^\]]+)\]\]/g, "[[$1]]")
			// Remote images: ![alt](https://...) -> [image: alt](https://...)
			.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_match, alt, url) => {
				const label = alt ? `image: ${alt}` : "image";
				return `[${label}](${url})`;
			})
			// Remote HTML images -> plain text marker.
			.replace(/<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi, "[image]")
	);
}
