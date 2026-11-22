import { expect, type Page, test } from "@playwright/test";
import {
  buildSeed,
  installMockBackend,
  type MockSeed,
  mockCalls,
  setMockFlag,
} from "./mock-backend";

const rowOf = (page: Page, key: string) =>
  page.locator(`[data-session-row-key="${key}"] > div`).first();
const titleBar = (page: Page) => page.locator("header[data-tauri-drag-region]");
const tabOf = (page: Page, title: string) =>
  titleBar(page).getByRole("button", { name: title, exact: true });

async function openApp(page: Page, seed: MockSeed = buildSeed()) {
  await installMockBackend(page, seed);
  await page.goto("/");
  await expect(rowOf(page, "claude::claude-0")).toBeVisible();
}

async function openSession(page: Page, key: string, marker: string) {
  await rowOf(page, key).click();
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
}

function messageScroller(page: Page) {
  return page.evaluateHandle(
    () => document.querySelector('[data-index="0"]')?.closest(".overflow-y-auto") ?? null
  );
}

test("saved edit survives switching tabs", async ({ page }) => {
  await openApp(page);
  await openSession(page, "claude::claude-1", "Question for Claude task 1");

  await page.getByText("Question for Claude task 1", { exact: true }).dblclick();
  await page.locator("textarea").fill("Edited question");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Edited question", { exact: true })).toBeVisible();

  const edits = await mockCalls(page, "session_edit_message");
  expect(edits).toHaveLength(1);
  expect(edits[0].args).toMatchObject({
    platform: "claude",
    sessionKey: "claude-1",
    content: "Edited question",
    expectedContent: "Question for Claude task 1",
  });

  await openSession(page, "claude::claude-2", "Question for Claude task 2");
  await tabOf(page, "Claude task 1").click();
  await expect(page.getByText("Edited question", { exact: true })).toBeVisible();
  await expect(page.getByText("Question for Claude task 1", { exact: true })).toHaveCount(0);
});

test("unsaved draft is kept when switching tabs", async ({ page }) => {
  await openApp(page);
  await openSession(page, "claude::claude-1", "Question for Claude task 1");

  await page.getByText("Question for Claude task 1", { exact: true }).dblclick();
  await page.locator("textarea").fill("Draft text not saved");
  await openSession(page, "claude::claude-2", "Question for Claude task 2");

  await expect(titleBar(page).locator('[title^="Unsaved edit draft"]')).toHaveCount(1);
  await tabOf(page, "Claude task 1").click();
  await expect(page.locator("textarea")).toHaveValue("Draft text not saved");
  expect(await mockCalls(page, "session_edit_message")).toHaveLength(0);
});

test("save failure stays visible inside the editor", async ({ page }) => {
  await openApp(page);
  await openSession(page, "claude::claude-1", "Question for Claude task 1");
  await setMockFlag(page, "failNextEdit", true);

  await page.getByText("Question for Claude task 1", { exact: true }).dblclick();
  await page.locator("textarea").fill("Will fail");
  await page.getByRole("button", { name: "Save Changes" }).click();

  await expect(page.getByRole("alert")).toContainText("changed on disk");
  await expect(page.locator("textarea")).toHaveValue("Will fail");
});

test("Ctrl+W and Ctrl+B are ignored while typing", async ({ page }) => {
  await openApp(page);
  await openSession(page, "claude::claude-1", "Question for Claude task 1");
  await page.getByText("Question for Claude task 1", { exact: true }).dblclick();
  await page.locator("textarea").fill("typing");

  await page.locator("textarea").press("Control+w");
  await page.locator("textarea").press("Control+b");

  await expect(tabOf(page, "Claude task 1")).toBeVisible();
  await expect(rowOf(page, "claude::claude-1")).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("typing");
});

test("expanded thinking and tool call survive virtual scrolling", async ({ page }) => {
  await openApp(page);
  const first = page.locator('[data-index="0"]');
  await expect(first).toContainText("Thinking");

  await first.getByRole("button", { name: "Thinking" }).click();
  await expect(page.getByText("Deep thinking text about the plan")).toBeVisible();
  await page.locator('[data-index="1"]').getByText("app.ts").click();
  await expect(page.getByText("+ const newValue = 2;")).toBeVisible();

  const scroller = await messageScroller(page);
  await scroller.evaluate((el) => {
    if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
  });
  await expect(first).toHaveCount(0);
  await scroller.evaluate((el) => {
    if (el) (el as HTMLElement).scrollTop = 0;
  });

  await expect(page.getByText("Deep thinking text about the plan")).toBeVisible();
  await expect(page.getByText("+ const newValue = 2;")).toBeVisible();
});

test("batch erase sends one backend command and reports the count", async ({ page }) => {
  await openApp(page);
  await openSession(page, "claude::claude-1", "Question for Claude task 1");

  const cells = page.locator('[data-testid="dna-track"] > div');
  await expect(cells).toHaveCount(3);
  const firstBox = await cells.nth(0).boundingBox();
  const lastBox = await cells.nth(2).boundingBox();
  if (!(firstBox && lastBox)) throw new Error("spectrum cells not laid out");
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 8 });
  await page.mouse.up();

  await page.getByRole("button", { name: "Erase Selected" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Cleared noise from 3 messages")).toBeVisible();

  const erases = await mockCalls(page, "session_erase_messages");
  expect(erases).toHaveLength(1);
  expect(erases[0].args.targets).toEqual([
    { editTarget: "claude-1::0", expectedContent: "Question for Claude task 1" },
    { editTarget: "claude-1::1", expectedContent: "Answer for Claude task 1" },
    { editTarget: "claude-1::2", expectedContent: "Follow-up for Claude task 1" },
  ]);
  expect(await mockCalls(page, "session_edit_message")).toHaveLength(0);
});

test("rapid session switching settles on the last click", async ({ page }) => {
  const seed = buildSeed({
    detailDelayMs: { "claude::claude-1": 700, "claude::claude-2": 350 },
  });
  await openApp(page, seed);

  await rowOf(page, "claude::claude-1").click();
  await rowOf(page, "claude::claude-2").click();
  await rowOf(page, "claude::claude-3").click();

  await expect(page.getByText("Question for Claude task 3", { exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByText("Question for Claude task 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Question for Claude task 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Question for Claude task 2", { exact: true })).toHaveCount(0);
});

test("tabs still load details after collapsing the sidebar", async ({ page }) => {
  await openApp(page);
  await openSession(page, "claude::claude-1", "Question for Claude task 1");
  await openSession(page, "claude::claude-2", "Question for Claude task 2");

  await page.keyboard.press("Control+b");
  await expect(rowOf(page, "claude::claude-1")).toBeHidden();
  await tabOf(page, "Claude task 1").click();
  await expect(page.getByText("Question for Claude task 1", { exact: true })).toBeVisible();
});

test("overview project filter is visible and clearable", async ({ page }) => {
  await openApp(page);
  await titleBar(page).getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "work/beta (20)", exact: true }).click();

  const clear = page.getByRole("button", { name: "Clear project filter" }).first();
  await expect(clear).toBeVisible();
  await expect(page.locator('[data-session-row-key^="claude::"]')).toHaveCount(0);
  await expect(page.locator('[data-session-row-key^="codex::"]').first()).toBeVisible();

  await clear.click();
  await expect(rowOf(page, "claude::claude-0")).toBeVisible();
});

test("ALL mode loads the remaining sessions of each platform", async ({ page }) => {
  await openApp(page);
  const codexRows = page.locator('[data-session-row-key^="codex::"]');
  await expect(codexRows).toHaveCount(40);

  await page.getByRole("button", { name: "Load more (30 remaining)" }).click();
  await expect(codexRows).toHaveCount(70);
  await expect(page.getByRole("button", { name: /Load more/ })).toHaveCount(0);
});

test("reopening the app restores the last active tab", async ({ page }) => {
  await openApp(page);
  await openSession(page, "claude::claude-3", "Question for Claude task 3");

  await page.reload();
  await expect(page.getByText("Question for Claude task 3", { exact: true })).toBeVisible();
  await expect(tabOf(page, "Claude task 3")).toBeVisible();
});

test("safe-write badge follows the platform of the open session", async ({ page }) => {
  await openApp(page);
  const footer = page.locator("footer");
  await expect(footer).toContainText("Safe Write (.bak)");

  await openSession(page, "codex::codex-0", "Question for Codex job 0");
  await expect(footer).toContainText("Revertible via edit log");
});

test("theme and language switch instantly without a save toast", async ({ page }) => {
  await openApp(page);
  await page.getByTitle("Switch to Light Mode").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "braun");

  await titleBar(page).getByRole("button", { name: "中", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.waitForTimeout(600);
  await expect(page.getByText("Settings saved")).toHaveCount(0);
  await expect(page.getByText("设置已保存")).toHaveCount(0);
});

test("English UI has no leftover Chinese text", async ({ page }) => {
  await openApp(page);
  const allowed = ["野生AI观测", "简体中文", "中文", "中"];
  const leftovers: Record<string, string[]> = {};
  for (const route of ["/", "/radar", "/prompts", "/settings", "/about"]) {
    await page.goto(route);
    await page.waitForTimeout(400);
    let text = await page.evaluate(() => document.body.innerText);
    for (const word of allowed) text = text.split(word).join(" ");
    const hits = text.match(/[\u4e00-\u9fa5][^\n]{0,20}/g) ?? [];
    if (hits.length > 0) leftovers[route] = hits;
  }
  expect(leftovers).toEqual({});
});

test("narrow window collapses the sidebar and keeps the header inside the pane", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 700 });
  await installMockBackend(page);
  await page.goto("/");
  await expect(page.locator('[data-index="0"]')).toBeVisible();

  await expect(rowOf(page, "claude::claude-0")).toBeHidden();
  const overflow = await page
    .locator('header[class*="@container"]')
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("context menu near the bottom edge stays inside the window", async ({ page }) => {
  await openApp(page);
  const point = await page.evaluate(() => {
    const limit = window.innerHeight - 30;
    let best: DOMRect | null = null;
    for (const el of document.querySelectorAll("[data-session-row-key] > div:first-child")) {
      const rect = el.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom <= limit && (!best || rect.bottom > best.bottom)) best = rect;
    }
    return best ? { x: best.left + 40, y: best.top + best.height / 2 } : null;
  });
  if (!point) throw new Error("no session row near the bottom");

  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.locator("[data-context-menu]");
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  if (!(box && viewport)) throw new Error("menu not laid out");
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
});

test("platform switcher lists platforms and switches by mouse and keyboard", async ({ page }) => {
  await openApp(page);
  const trigger = page.getByRole("button", { name: "Switch platform" });
  await expect(trigger).toContainText("All");

  await trigger.click();
  const list = page.getByRole("listbox", { name: "Switch platform" });
  await expect(list.getByRole("option")).toHaveText([/All\s*78/, /Claude\s*8/, /Codex\s*70/, /Pi/]);
  await expect(list).toContainText("No sessions yet");
  await list.getByRole("option", { name: /Codex/ }).click();
  await expect(page).toHaveURL(/\/codex$/);
  await expect(list).toHaveCount(0);
  await expect(page.locator('[data-session-row-key^="claude::"]')).toHaveCount(0);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/claude$/);

  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
