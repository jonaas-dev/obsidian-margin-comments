/**
 * The quote a card shows, with inline Markdown syntax taken out.
 *
 * The quote reads the note's source (#115), so formatting markers came through
 * verbatim: `**bold**`, `[[links]]`, backticks, list dashes. In a one-line quote
 * that ends in an ellipsis they take the room the words need (#128).
 *
 * Display only. The anchor, the stored text and reading mode's lookup all keep
 * the source, which is what they match against. Not a Markdown render either:
 * the quote is a single line, and rendering would bring block elements into it.
 */
export function displayQuote(source: string): string {
	// A quote is a single line in the UI; running the regex chain on pathological
	// Markdown can backtrack. Fall back to the raw text for very long anchors.
	if (source.length > 4000) return source;

	// Code spans first, and their content kept verbatim: `a*b*c` is code, not
	// emphasis. Parked behind private-use characters, which no note text carries.
	const code: string[] = [];
	let text = source.replace(/`([^`]+)`/g, (_match, inner: string) => {
		code.push(inner);
		return `\uE000${code.length - 1}\uE001`;
	});

	text = text
		// Embeds and wikilinks: the alias when there is one, the target otherwise.
		.replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]+)\]\]/g, "$1")
		// Markdown links and images: the visible text.
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		// Paired emphasis, only where the markers hug text. A lone asterisk in
		// `2 * 3` or the underscores inside `snake_case_name` are not markup.
		.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
		.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
		.replace(/==(?=\S)(.+?)(?<=\S)==/g, "$1")
		.replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1$2")
		.replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, "$1$2")
		// Line prefixes: headings, quotes, tasks, bullets, numbered items.
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/^\s*>\s?/, "")
		.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "")
		.replace(/^\s*[-*+]\s+/, "")
		.replace(/^\s*\d+[.)]\s+/, "");

	text = text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => code[Number(index)]);

	// Syntax alone, such as a bare "- ", is still what the comment was made on.
	return text.trim() === "" ? source : text;
}
