// Build first: npm run build:web --prefix server. Uses an isolated temporary database on port 39128.
// Install a browser: cd web && npx playwright install chromium. Optional CHROMIUM_PATH/CHROMIUM_ARGS.
const { chromium } = require("../web/node_modules/@playwright/test"),
  assert = require("node:assert/strict"),
  { spawn } = require("node:child_process"),
  fs = require("node:fs"),
  os = require("node:os");
(async () => {
  const data = fs.mkdtempSync(os.tmpdir() + "/ik-feature-ui-"),
    base = "http://127.0.0.1:39128";
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: require("node:path").resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: "39128",
      DATA_DIR: data,
      AUTO_FIRST_ADMIN: "1",
      ADMIN_USERNAMES: "",
    },
    stdio: "ignore",
  });
  let b;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 30));
    }
    const ids = [];
    for (const username of ["owner", "bob"]) {
      const r = await fetch(base + "/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "testing-password-123" }),
      });
      assert.equal(r.status, 201);
      ids.push((await r.json()).id);
    }
    b = await chromium.launch({
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
      args: process.env.CHROMIUM_ARGS
        ? JSON.parse(process.env.CHROMIUM_ARGS)
        : [],
    });
    const ctxA = await b.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      ctxB = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    const a = await ctxA.newPage(),
      p = await ctxB.newPage();
    async function login(page, name) {
      await page.goto(base);
      await page.locator(".ik-guest-account").click();
      await page.locator("input[name=username]").fill(name);
      await page.locator("input[name=password]").fill("testing-password-123");
      await page
        .locator(".local-auth-overlay")
        .click({ position: { x: 2, y: 2 } });
      assert.ok(await page.locator(".local-auth").isVisible());
      await page.locator(".local-auth .connect").click();
      await page.locator(".local-auth").waitFor({ state: "hidden" });
      await page.locator(".home-account-tools").waitFor();
    }
    await login(a, "owner");
    await login(p, "bob");
    assert.ok(
      await a
        .getByRole("link", { name: "管理后台 →", exact: true })
        .isVisible(),
    );
    assert.equal(
      await p.getByRole("link", { name: "管理后台 →", exact: true }).count(),
      0,
    );
    console.log(
      "PASS login overlay stays open on backdrop, admin-only home entry",
    );
    await p.goto(base + "/profile/" + ids[1]);
    await p
      .locator(".ik-profile-page,.ik-profile")
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    assert.equal(await p.getByText("用户不存在", { exact: true }).count(), 0);
    console.log("PASS real user profile no missing-user screen");
    await a.goto(base + "/admin");
    await a.getByRole("heading", { name: "绳网 · 管理后台" }).waitFor();
    await a
      .getByRole("button", { name: "站点外观 / 设置", exact: true })
      .click();
    await a.getByLabel("网站标题", { exact: true }).fill("测试绳网");
    await a.getByRole("button", { name: "保存外观", exact: true }).click();
    await a.waitForTimeout(400);
    assert.equal(await a.locator(".ik-header").count(), 0);
    assert.equal(await a.locator(".ik-mobile-nav").count(), 0);
    assert.equal(await a.title(), "测试绳网");
    console.log("PASS isolated admin navigation and live site title");
    const patch = await a.request.patch(base + "/v1/admin/users/" + ids[1], {
      data: {
        nickname: "妮可测试",
        bio: "个人空间测试",
        level: 22,
        denny: 500,
        polychrome: 160,
        avatarUrl: "/images/default-avatar.webp",
      },
    });
    assert.equal(patch.status(), 200);
    await p.goto(base);
    await p.locator(".home-account-tools").filter({ hasText: /160/ }).waitFor();
    assert.match(await p.locator(".home-account-tools").innerText(), /160/);
    assert.equal(await p.getByText(/管理员发放/).count(), 0);
    console.log(
      "PASS edited user profile and polychrome visible without acquisition hint",
    );
    await a.goto(base + "/messages");
    await p.goto(base + "/messages");
    await a
      .locator(".contact-list .contact > button:first-child")
      .filter({ hasText: "妮可测试" })
      .click();
    await p
      .locator(".contact-list .contact > button:first-child")
      .filter({ hasText: "owner" })
      .click();
    await a.getByRole("textbox", { name: "消息内容" }).fill("浏览器真实私聊");
    await a.getByRole("button", { name: "发送", exact: true }).click();
    await p
      .locator(".timeline")
      .getByText("浏览器真实私聊", { exact: true })
      .waitFor({ timeout: 10000 });
    console.log("PASS two real browser accounts send and receive");
    await a
      .getByRole("button", { name: "添加 妮可测试 为好友", exact: true })
      .click();
    await p.locator("aside details summary").click();
    await p.getByRole("button", { name: "接受", exact: true }).click();
    await p.locator("aside .friend").filter({ hasText: "owner" }).waitFor();
    console.log("PASS browser friend request and acceptance");
    await a.getByRole("button", { name: "新建群聊", exact: true }).click();
    await a.getByLabel("群名称", { exact: true }).fill("浏览器群聊");
    await a
      .locator(".group-form")
      .getByLabel("妮可测试", { exact: true })
      .check();
    await a.getByRole("button", { name: "创建群聊", exact: true }).click();
    await a.locator("article h2").filter({ hasText: "浏览器群聊" }).waitFor();
    await p
      .locator(".conversation")
      .filter({ hasText: "[群] 浏览器群聊" })
      .click();
    await a
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill("实时群消息测试");
    await a.getByRole("button", { name: "发送", exact: true }).click();
    await p
      .locator(".timeline")
      .getByText("实时群消息测试", { exact: true })
      .waitFor();
    console.log("PASS browser real-time group creation and delivery");
    await a.waitForFunction(
      () => !document.querySelector("input[type=file]").disabled,
    );
    await a
      .getByLabel("选择附件", { exact: true })
      .setInputFiles({
        name: "browser.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("private file payload"),
      });
    await p
      .locator(".timeline")
      .getByText("browser.txt", { exact: true })
      .waitFor();
    const link = p
      .locator(".timeline a")
      .filter({ hasText: "下载 browser.txt" });
    const href = await link.getAttribute("href");
    assert.equal((await p.request.get(base + href)).status(), 200);
    assert.equal(
      (await p.request.get(base + href)).headers()["content-type"],
      "application/octet-stream",
    );
    assert.equal((await fetch(base + href)).status, 401);
    console.log("PASS private attachment download and guest denial");
    await p
      .getByRole("textbox", { name: "搜索聊天记录", exact: true })
      .fill("实时群消息");
    await p.getByRole("button", { name: "搜索记录", exact: true }).click();
    await p
      .locator(".timeline")
      .getByText("实时群消息测试", { exact: true })
      .waitFor();
    assert.equal(
      await p
        .locator(".timeline")
        .getByText("browser.txt", { exact: true })
        .count(),
      0,
    );
    await p.getByRole("button", { name: "返回聊天", exact: true }).click();
    console.log("PASS browser message search");
    await a.locator(".group-info summary").click();
    a.once("dialog", (d) => d.accept());
    await a.getByRole("button", { name: "移出", exact: true }).click();
    await p.locator("article h2").waitFor({ state: "hidden" });
    console.log("PASS removed member immediately loses group view");
    await a.setViewportSize({ width: 390, height: 844 });
    await a.goto(base + "/admin");
    await a.getByRole("button", { name: "用户 / 会话", exact: true }).click();
    assert.equal(
      await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    console.log("PASS mobile admin no horizontal overflow");
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (b) await b.close();
    const done = new Promise((r) => child.once("exit", r));
    child.kill();
    await done;
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
