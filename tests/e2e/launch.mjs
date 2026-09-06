import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 9333;

/**
 * Launch an isolated Obsidian and attach over CDP.
 *
 * Playwright's Electron support needs the --inspect fuse, which this production
 * build has disabled, so the renderer's remote debugging port is used instead.
 * A private user-data-dir sidesteps the single-instance lock: without it the
 * launch silently hands off to whatever Obsidian the developer already has open
 * and exits.
 */
export async function launchObsidian(vaultPath) {
	const userData = join(tmpdir(), `obsidian-e2e-${Date.now()}`);
	mkdirSync(userData, { recursive: true });
	writeFileSync(
		join(userData, "obsidian.json"),
		JSON.stringify({ vaults: { e2e: { path: vaultPath, ts: Date.now(), open: true } } }),
	);

	const proc = spawn(OBSIDIAN, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	const browser = await waitForCdp();
	const context = browser.contexts()[0];
	const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
	await page.waitForLoadState("domcontentloaded");

	return {
		page,
		async close() {
			await browser.close().catch(() => {});
			proc.kill();
			// Obsidian keeps writing to its profile for a moment after SIGTERM, so
			// removal races with it. The directory is under tmp; leaving it is
			// harmless, and failing here would mask the test's real error.
			await new Promise((r) => setTimeout(r, 500));
			try {
				rmSync(userData, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		},
	};
}

async function waitForCdp(attempts = 30) {
	for (let i = 0; i < attempts; i++) {
		try {
			return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
		} catch {
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	throw new Error(`No CDP endpoint on port ${PORT} after ${attempts}s`);
}

/** Wait until Obsidian's app object exists and the workspace is ready. */
export async function waitForWorkspace(page, timeout = 60000) {
	await page.waitForFunction(() => window.app?.workspace?.layoutReady === true, null, { timeout });
}

/**
 * Turn off Restricted Mode and load the plugin.
 *
 * A fresh user-data-dir always starts restricted, so community plugins are
 * listed as enabled but never loaded — and silently, with nothing on the
 * console. Enabling explicitly also keeps the run independent of whatever
 * state the profile happens to be in.
 */
export async function enablePlugin(page, id, timeout = 30000) {
	await page.evaluate(async (pluginId) => {
		await window.app.plugins.setEnable(true);
		await window.app.plugins.enablePlugin(pluginId);
	}, id);
	await page.waitForFunction(
		(pluginId) => window.app.plugins.plugins[pluginId] != null,
		id,
		{ timeout },
	);
}

/**
 * A throwaway vault with this repo linked in as a plugin.
 *
 * Tests get their own vault rather than the developer's: they create notes and
 * the plugin writes sidecars, and a shared vault would leave both fighting over
 * the same files while Obsidian is open on it.
 */
export function createTempVault(seed = {}) {
	const vault = join(tmpdir(), `obsidian-vault-${Date.now()}`);
	mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
	symlinkSync(REPO, join(vault, ".obsidian", "plugins", "inline-comments"));
	// The plugin directory is the repo itself, so its data.json outlives the
	// throwaway vault. Left in place, settings a test chose leak into the next
	// run and it starts against state no fresh install would have.
	rmSync(join(REPO, "data.json"), { force: true });
	writeFileSync(join(vault, ".obsidian", "community-plugins.json"), '["inline-comments"]');
	for (const [name, content] of Object.entries(seed)) {
		// Seeds may name a path inside a folder — a sidecar under .inline-comments,
		// say — so the folder is created rather than assumed.
		mkdirSync(dirname(join(vault, name)), { recursive: true });
		writeFileSync(join(vault, name), content);
	}
	return {
		path: vault,
		remove() {
			try {
				rmSync(vault, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		},
	};
}

/**
 * Close anything covering the workspace.
 *
 * Enabling plugins raises the Restricted Mode dialog, and its backdrop swallows
 * every synthetic pointer event: mouse moves land on .modal-bg instead of the
 * editor, so hover behaviour appears broken when it is merely covered.
 */
export async function dismissModals(page) {
	await page.evaluate(() => {
		document.querySelectorAll(".modal-close-button").forEach((b) => b.click());
		document.querySelectorAll(".modal-bg").forEach((b) => b.remove());
		document.querySelectorAll(".modal-container").forEach((b) => b.remove());
	});
	await page.waitForTimeout(200);
}
