/**
 * The few strings the plugin cannot leave in English.
 *
 * Everything else the plugin says sits in a control with a name Obsidian's own
 * UI puts in English too. This one is different: it stands in for the reader's
 * own text, inside their own note, so English would read as content that got
 * there by mistake.
 *
 * Deliberately a short list. A bad translation is worse than the English, so
 * only languages that can be written with confidence are here and everything
 * else falls back — which is also what an unknown or missing language does.
 */
const EMPTY_LINE: Record<string, string> = {
	en: "Empty line",
	es: "Línea vacía",
	ca: "Línia buida",
	pt: "Linha vazia",
	fr: "Ligne vide",
	it: "Riga vuota",
	de: "Leere Zeile",
};

/**
 * Obsidian's language, as a bare code.
 *
 * `document.documentElement.lang` is what the app sets and is the reliable
 * read: measured, `localStorage.getItem("language")` is null on an English
 * install rather than "en", so it cannot be told apart from unset. Regional
 * tags are narrowed to the language ("pt-BR" to "pt"), since these strings do
 * not differ by region.
 */
export function documentLanguage(lang: string | null | undefined): string {
	return (lang ?? "").trim().toLowerCase().split("-")[0];
}

/** What a card shows in place of a quote when the commented line is empty. */
export function emptyLineLabel(lang: string | null | undefined): string {
	return EMPTY_LINE[documentLanguage(lang)] ?? EMPTY_LINE.en;
}
