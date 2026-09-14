import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const OBSIDIAN = process.env.OBSIDIAN_APP ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
	// Whoever holds the port answers the connection below, so a launch started while
	// the previous file's Obsidian is still shutting down attaches to that one: it has
	// no window left, and every later file failed the same way within a second (#242).
	await waitForFreePort();

	const userData = join(tmpdir(), `obsidian-e2e-${Date.now()}`);
	mkdirSync(userData, { recursive: true });
	writeFileSync(
		join(userData, "obsidian.json"),
		JSON.stringify({ vaults: { e2e: { path: vaultPath, ts: Date.now(), open: true } } }),
	);

	const proc = spawn(OBSIDIAN, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let browser;
	let page;
	try {
		browser = await waitForCdp();
		page = await waitForPage(browser);
		await page.waitForLoadState("domcontentloaded");
	} catch (error) {
		// Nothing else will ever stop this process. Left running, it keeps the
		// debugging port, and every later test file attaches to it or fails the
		// same way, leaving another instance behind each time (#227).
		await closeBrowser(browser);
		await stop(proc);
		throw error;
	}

	return {
		page,
		async close() {
			await closeBrowser(browser);
			await stop(proc);
			try {
				rmSync(userData, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		},
	};
}

async function waitForFreePort(timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (!(await portIsFree())) {
		if (Date.now() > deadline) {
			throw new Error(
				`Port ${PORT} is still in use after ${timeout / 1000}s. Another Obsidian is attached to it; ` +
					`attaching here would drive that instance instead of a fresh one.`,
			);
		}
		await sleep(250);
	}
}

function portIsFree() {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen(PORT, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}

/**
 * Obsidian can answer on the debugging port before its window is a target, so the
 * page list may still be empty right after attaching (#242).
 */
async function waitForPage(browser, timeout = 15000) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const page = browser
			.contexts()
			.flatMap((context) => context.pages())
			.find((p) => !p.url().startsWith("devtools://"));
		if (page) return page;
		if (Date.now() > deadline) {
			throw new Error(`Attached over CDP, but Obsidian opened no window within ${timeout / 1000}s`);
		}
		await sleep(100);
	}
}

async function closeBrowser(browser) {
	// Bounded: with a popout window open, closing the CDP connection was seen to hang,
	// leaving this process running after the test file ended.
	await Promise.race([browser?.close().catch(() => {}), sleep(3000)]);
}

/** Kill Obsidian and wait until it has exited, so the port is free for the next launch. */
async function stop(proc) {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	const exited = new Promise((resolve) => proc.once("exit", resolve));
	proc.kill();
	if (await Promise.race([exited.then(() => true), sleep(10000).then(() => false)])) return;
	proc.kill("SIGKILL");
	await Promise.race([exited, sleep(5000)]);
}

async function waitForCdp(attempts = 30) {
	let lastError;
	for (let i = 0; i < attempts; i++) {
		try {
			return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
		} catch (error) {
			lastError = error;
			await sleep(1000);
		}
	}
	// The last error, not just the attempt count: an endpoint that answers but
	// cannot be driven (an Electron too old for this Playwright) otherwise reads
	// exactly like one that never came up.
	throw new Error(`Could not attach over CDP on port ${PORT} after ${attempts}s: ${lastError?.message ?? lastError}`);
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
	symlinkSync(REPO, join(vault, ".obsidian", "plugins", "margin-comments"));
	// The plugin directory is the repo itself, so its data.json outlives the
	// throwaway vault. Left in place, settings a test chose leak into the next
	// run and it starts against state no fresh install would have.
	rmSync(join(REPO, "data.json"), { force: true });
	writeFileSync(join(vault, ".obsidian", "community-plugins.json"), '["margin-comments"]');
	for (const [name, content] of Object.entries(seed)) {
		// Seeds may name a path inside a folder — a sidecar under .margin-comments,
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
