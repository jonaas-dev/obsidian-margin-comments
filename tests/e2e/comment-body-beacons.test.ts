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
			if (req.url().includes("evil.example")) asked.push(req.url());
		});
		await waitForWorkspace(page);
		await enablePlugin(page, "margin-comments");
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
