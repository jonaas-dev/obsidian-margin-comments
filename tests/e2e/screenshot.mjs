import { launchObsidian, waitForWorkspace, enablePlugin, createTempVault, dismissModals } from "./launch.mjs";

const BODY = [
  "# Design review",
  "",
  "The panel should read as part of Obsidian rather than a widget bolted on.",
  "",
  "Actions stay out of the way until you reach for them.",
  "",
  "A resolved thread stays legible but visibly settled.",
].join("\n");

const vault = createTempVault({ "note.md": BODY });
const session = await launchObsidian(vault.path);
const page = session.page;

async function comment(lineIndex, text) {
  const g = await page.locator(".cm-gutters").boundingBox();
  const l = await page.locator(".cm-line").nth(lineIndex).boundingBox();
  await page.mouse.move(g.x + g.width / 2, l.y + l.height / 2);
  await page.waitForSelector(".inline-comment-marker", { timeout: 5000 });
  await page.mouse.click(g.x + g.width / 2, l.y + l.height / 2);
  await page.waitForSelector(".inline-comment-composer", { timeout: 5000 });
  await page.locator(".inline-comment-composer-input").click();
  await page.locator(".inline-comment-composer-input").fill(text);
  await page.locator(".inline-comment-composer .mod-cta").click();
  await page.waitForTimeout(1200);
}

try {
  await waitForWorkspace(page);
  await enablePlugin(page, "margin-comments");
  await page.evaluate(async () => {
    const f = window.app.vault.getAbstractFileByPath("note.md");
    await window.app.workspace.getLeaf(true).openFile(f, { state: { mode: "source" } });
  });
  await page.waitForSelector(".cm-editor");
  await dismissModals(page);

  await comment(2, "Does this read as **native** to Obsidian?");
  await comment(4, "Icons only, revealed on hover.");
  await comment(6, "This one gets resolved.");

  await page.evaluate(async () => {
    await window.app.commands.executeCommandById("margin-comments:toggle-comments-panel");
  });
  await page.waitForSelector(".inline-comment-panel");
  await page.waitForTimeout(500);

  // A reply on the first thread.
  await page.locator(".inline-comment-card").first().hover();
  const box = page.locator(".inline-comment-replybox-input").first();
  await box.click();
  await box.fill("Replies land inline, at the foot of the thread.");
  await page.locator(".inline-comment-send").first().click();
  await page.waitForTimeout(1200);

  // Resolve the last thread.
  const resolves = page.locator('[aria-label="Resolve"]');
  await resolves.last().click();
  await page.waitForTimeout(1200);

  // Hover the first card so the actions are visible in the shot.
  await page.locator(".inline-comment-card").first().hover();
  await page.waitForTimeout(400);

  const panel = page.locator(".workspace-split.mod-right-split");
  await panel.screenshot({ path: "/tmp/panel-light.png" });

  await page.evaluate(() => window.app.changeTheme?.("obsidian") ?? window.app.customCss?.setTheme?.("obsidian"));
  await page.evaluate(() => document.body.classList.remove("theme-light"));
  await page.evaluate(() => document.body.classList.add("theme-dark"));
  await page.waitForTimeout(600);
  await page.locator(".inline-comment-card").first().hover();
  await panel.screenshot({ path: "/tmp/panel-dark.png" });

  console.log("capturas guardadas");
} finally {
  await session.close();
  vault.remove();
}
