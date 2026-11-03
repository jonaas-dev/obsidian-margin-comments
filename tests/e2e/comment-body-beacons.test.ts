import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	launchObsidian,
	waitForWorkspace,
	enablePlugin,
	createTempVault,
	dismissModals,
} from "./launch.mjs";
import { hashString } from "../../src/utils";

const NOTE = "note.md";
const STORAGE_DIR = ".margin-comments";
const E = "https://evil.example";

const BODIES: [string, string][] = [
	["md-angle", "![a](<https://evil.example/angle.png>)"],
	["md-single-title", "![a](https://evil.example/single.png 'title')"],
	["md-paren-title", "![a](https://evil.example/paren.png (title))"],
	["md-brackets-alt", "![a [b]](https://evil.example/brackets.png)"],
	["md-reference", "![a][r]\n\n[r]: https://evil.example/reference.png"],
	["html-unquoted", "<img src=https://evil.example/unquoted.png>"],
	["html-srcset", '<img srcset="https://evil.example/srcset.png 1x">'],
	["html-entity", '<img src="&#104;ttps://evil.example/entity.png">'],
	["html-picture", '<picture><source srcset="https://evil.example/picture.png"><img></picture>'],
	["html-iframe", '<iframe src="https://evil.example/iframe.html"></iframe>'],
	["html-video", '<video src="https://evil.example/video.mp4" autoplay></video>'],
	["html-audio", '<audio src="https://evil.example/audio.mp3" autoplay></audio>'],
	["md-plain", "![a](https://evil.example/plain.png)"],
	["code-fence", "`![](https://evil.example/incode.png)`"],
	["styled-text", '<span style="color:red">styled</span>'],
	// Forms that fetch without any of the attributes LOADERS names, added while
	// auditing 2026-10-07: CSS, SVG and <link> reach the network by other routes.
	["css-inline", '<div style="background-image:url(https://evil.example/inline.png)">x</div>'],
	[
		"css-block",
		"<style>.bk{background:url(https://evil.example/styleblock.png)}</style>" +
			'<div class="bk">x</div>',
	],
	["svg-image", '<svg><image href="https://evil.example/svgimage.png" /></svg>'],
	["svg-use", '<svg><use href="https://evil.example/svguse.svg#i" /></svg>'],
	["link-stylesheet", '<link rel="stylesheet" href="https://evil.example/link.css">'],
	["link-preload", '<link rel="preload" as="image" href="https://evil.example/preload.png">'],
	["html-object", '<object data="https://evil.example/object.html"></object>'],
	["html-embed", '<embed src="https://evil.example/embed.html">'],
	["html-input-image", '<input type="image" src="https://evil.example/input.png">'],
	["html-track", '<video controls><track src="https://evil.example/track.vtt"></video>'],
	[
		"table-background",
		'<table background="https://evil.example/tablebg.png"><tr><td>x</td></tr></table>',
	],
	["meta-refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example/meta">'],
	// URLs the page reads differently from how they are written (#369).
	["url-tab", '<img src="ht&#9;tps://evil.example/url-tab.png">'],
	["url-newline", '<img src="ht&#10;tps://evil.example/url-newline.png">'],
	["url-control", '<img src="&#1;https://evil.example/url-control.png">'],
	["url-backslash", '<img src="\\\\evil.example/url-backslash.png">'],
	["srcset-tab", '<img srcset="ht&#9;tps://evil.example/srcset-tab.png 1x">'],
	[
		"background-tab",
		'<table background="ht&#9;tps://evil.example/background-tab.png"><tr><td>x</td></tr></table>',
	],
	["object-tab", '<object data="ht&#9;tps://evil.example/object-tab.html"></object>'],
	// CSS that loads without spelling `url(` (#370).
	["css-image-set", `<div style='background-image:image-set("${E}/image-set.png" 1x)'>x</div>`],
	[
		"css-webkit-image-set",
		`<div style='background-image:-webkit-image-set("${E}/webkit-image-set.png" 1x)'>x</div>`,
	],
	["css-escaped", `<div style="background:\\75rl(${E}/escaped.png)">x</div>`],
	["css-cursor", `<div style="cursor:url(${E}/cursor.png),auto">x</div>`],
	// SVG attributes that load (#371).
	[
		"svg-feimage",
		`<svg><filter id="fa"><feImage href="${E}/feimage.png"/></filter><rect width="10" height="10" filter="url(#fa)"/></svg>`,
	],
	[
		"svg-feimage-xlink",
		`<svg><filter id="fb"><feImage xlink:href="${E}/feimage-xlink.png"/></filter><rect width="10" height="10" filter="url(#fb)"/></svg>`,
	],
	["svg-fill", `<svg><rect width="10" height="10" fill="url(${E}/fill.svg#g)"/></svg>`],
	["svg-filter", `<svg><rect width="10" height="10" filter="url(${E}/filter.svg#f)"/></svg>`],
	["svg-mask", `<svg><rect width="10" height="10" mask="url(${E}/mask.svg#m)"/></svg>`],
	["svg-clip", `<svg><rect width="10" height="10" clip-path="url(${E}/clip.svg#c)"/></svg>`],
	["svg-marker", `<svg><path d="M0 0L10 10" marker-end="url(${E}/marker.svg#m)"/></svg>`],
	[
		"svg-pattern",
		`<svg><pattern id="pp" href="${E}/pattern.svg#p"/><rect width="10" height="10" fill="url(#pp)"/></svg>`,
	],
	[
		"svg-set",
		`<svg><image width="10" height="10"><set attributeName="href" to="${E}/set.png"/></image></svg>`,
	],
	[
		"svg-foreign-img",
		`<svg><foreignObject width="10" height="10"><img src="${E}/foreign.png"></foreignObject></svg>`,
	],
	["base-href", `<base href="${E}/base/"><img src="rel.png">`],
	["link-imagesrcset", `<link rel="preload" as="image" imagesrcset="${E}/imagesrcset.png 1x">`],
	// What a card may offer as a link in place of what it does not show (#368).
	["link-srcset-script", '<img srcset="x, javascript:void(window.__mcRan=1) 2x" alt="L-SRCSET">'],
	["link-data", '<img src="data:text/html,<script>parent.__mcRan=1</script>" alt="L-DATA">'],
	["link-web", '<img src="https://evil.example/web.png" alt="L-HTTPS">'],
	// Code blocks rendered by a processor that writes after the card is built (#372).
	["late-attr-first", "```late-block\nattr-first\n```"],
	["late-append-first", "```late-block\nappend-first\n```"],
	["late-sync", "```late-block\nsync\n```"],
];

function comment(id: string, content: string) {
	return {
		id,
		filePath: NOTE,
		anchor: {
			selectedText: "alpha",
			textHash: hashString("alpha"),
			isLineComment: false,
			contextBefore: "",
			contextAfter: "",
			lineHint: 1,
			startOffset: 0,
			endOffset: 5,
		},
		content,
		author: "someone",
		createdAt: 1000,
		updatedAt: 1000,
		resolved: false,
		parentId: null,
	};
}

describe("a comment body that tries to phone home", () => {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	let vault: { path: string; remove(): void };
	let session: { page: any; close(): Promise<void> };
	let page: any;
	/* eslint-enable @typescript-eslint/no-explicit-any */
	const asked: string[] = [];

	beforeAll(async () => {
		const sidecar = JSON.stringify({
			version: 1,
			filePath: NOTE,
			comments: BODIES.map(([id, body]) => comment(id, body)),
		});
		vault = createTempVault({
			[NOTE]: "alpha beta gamma\ndelta epsilon",
			[`${STORAGE_DIR}/${hashString(NOTE)}.json`]: sidecar,
		});
		session = await launchObsidian(vault.path);
		page = session.page;
		page.on("request", (req: { url(): string }) => {
			// app:// is the app's own files: on desktop a scheme-less `\\host` resolves there.
			if (req.url().includes("evil.example") && !req.url().startsWith("app:"))
				asked.push(req.url());
		});
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
		// Stands in for another plugin's code-block processor that writes late.
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["margin-comments"];
			plugin.registerMarkdownCodeBlockProcessor(
				"late-block",
				(source: string, el: HTMLElement) => {
					const kind = source.trim();
					if (kind === "sync") {
						el.createEl("img", { attr: { src: "https://evil.example/late-sync.png" } });
						return;
					}
					setTimeout(() => {
						if (kind === "attr-first")
							el.createEl("img", {
								attr: { src: "https://evil.example/late-attr-first.png" },
							});
						if (kind === "append-first") {
							const img = el.createEl("img");
							img.src = "https://evil.example/late-append-first.png";
						}
					}, 200);
				},
			);
		});
		await page.evaluate(async (note: string) => {
			const file = window.app.vault.getAbstractFileByPath(note);
			await window.app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		}, NOTE);
		await page.waitForSelector(".workspace-leaf.mod-active .cm-editor", { timeout: 30000 });
		await dismissModals(page);
		await page.evaluate(async () => {
			await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
		});
		await page.waitForSelector(".inline-comment-panel .inline-comment-card", {
			timeout: 10000,
		});
		await page.waitForTimeout(4000);
	}, 240000);

	afterAll(async () => {
		await session?.close();
		vault?.remove();
	});

	it("issues no request for any of them", async () => {
		// Every one of these left the machine before #263: angle-bracket
		// destinations, reference-style images, srcset, <picture>, <iframe>,
		// autoplaying <video> and <audio>, and an entity-encoded URL that reaches
		// the DOM already decoded. Asserted on the network rather than on the
		// markup, because the markup is not what the promise in SECURITY.md is about.
		expect(asked).toEqual([]);
	});

	it("leaves a link where the image was, rather than nothing", async () => {
		// Removing the content outright would hide that a comment had an image in
		// it at all; the reader can still choose to follow the link.
		const links = await page.evaluate(() =>
			Array.from(document.querySelectorAll(".inline-comment-panel a"))
				.map((a) => a.getAttribute("href") ?? "")
				.filter((href: string) => href.includes("evil.example")),
		);
		expect(links.length).toBeGreaterThan(0);
	});

	it("keeps no styling in any body", async () => {
		// Dropped whatever it says (#370), so a body that styles text is the case
		// to look at, not only one whose style fetches.
		const styled = await page.evaluate(
			() =>
				document.querySelectorAll(
					".inline-comment-body [style], .inline-comment-body style",
				).length,
		);
		expect(styled).toBe(0);
	});

	it("offers only web addresses as links", async () => {
		const hrefs: string[] = await page.evaluate(() =>
			Array.from(
				document.querySelectorAll(".inline-comment-panel .inline-comment-body a[href]"),
			).map((a) => (a as HTMLAnchorElement).href),
		);
		expect(hrefs.filter((href) => !/^https?:/i.test(href))).toEqual([]);
	});

	it("keeps the alt text of what it replaced", async () => {
		const text: string = await page.evaluate(
			() => document.querySelector(".inline-comment-panel")?.textContent ?? "",
		);
		expect(text).toContain("L-HTTPS");
		expect(text).toContain("L-SRCSET");
	});

	it("runs nothing when the reader clicks what is left", async () => {
		for (const label of ["L-SRCSET", "L-DATA"]) {
			const link = page
				.locator(".inline-comment-panel .inline-comment-body", { hasText: label })
				.first()
				.locator("a")
				.first();
			if ((await link.count()) > 0) await link.click({ timeout: 5000 }).catch(() => {});
		}
		await page.waitForTimeout(500);
		const state = await page.evaluate(() => ({
			ran: (window as unknown as { __mcRan?: unknown }).__mcRan ?? null,
			app: typeof window.app,
		}));
		expect(state).toEqual({ ran: null, app: "object" });
	});

	it("still renders ordinary Markdown", async () => {
		// The body is rendered in a document with no browsing context before it is
		// adopted into the card. If that broke the renderer, it would show here.
		const rendered = await page.evaluate(() => {
			const bodies = Array.from(document.querySelectorAll(".inline-comment-body"));
			return {
				cards: bodies.length,
				code: document.querySelectorAll(".inline-comment-body code").length,
			};
		});
		expect(rendered.cards).toBeGreaterThan(0);
		expect(rendered.code).toBeGreaterThan(0);
	});
});
