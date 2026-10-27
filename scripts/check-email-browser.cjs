// Real local SMTP protocol + browser UI. No production credentials used.
const { chromium } = require("../web/node_modules/@playwright/test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const { createSmtpSink } = await import("../server/test-helpers/smtp.mjs");
  const { server: smtp, messages } = await createSmtpSink();
  const dir = mkdtempSync(tmpdir() + "/sw-email-browser-"),
    base = "http://127.0.0.1:39150";
  let browser, child;
  try {
    child = spawn(process.execPath, ["index.mjs"], {
      cwd: require("node:path").resolve(__dirname, "../server"),
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: "39150",
        SEED_DEMO: "0",
        SECURE_COOKIE: "0",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.address().port),
        SMTP_SECURE: "0",
        SMTP_ALLOW_INSECURE: "1",
        SMTP_FROM: "noreply@example.test",
        SMTP_USER: "",
        SMTP_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stderr.on("data", (d) => (log += d));
    child.stdout.on("data", (d) => (log += d));
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(base + "/health")).ok) break;
      } catch {}
      if (child.exitCode !== null) throw Error(log);
      await new Promise((r) => setTimeout(r, 40));
    }
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: process.env.CHROMIUM_ARGS
        ? JSON.parse(process.env.CHROMIUM_ARGS)
        : ["--no-sandbox"],
    });
    const open = async () => {
      const p = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await p.goto(base);
      await p
        .locator(".ik-mobile-nav")
        .getByRole("button", { name: "我的", exact: true })
        .click();
      return p;
    };
    const send = async (p) => {
      const done = p.waitForResponse(
        (r) =>
          r.url().endsWith("/v1/auth/email-codes") &&
          r.request().method() === "POST",
      );
      await p.getByRole("button", { name: "发送验证码", exact: true }).click();
      assert.equal((await done).status(), 200);
      await p.locator("input[name=code]").fill(messages.at(-1).code);
    };
    const signedIn = async (p) => {
      await p.locator(".local-auth").waitFor({ state: "hidden" });
      await p.locator(".ik-header.is-login").waitFor();
      return (await (await p.request.get(base + "/v1/me")).json()).id;
    };
    const p = await open();
    await p.getByRole("button", { name: "邮箱验证码", exact: true }).click();
    await p
      .getByRole("button", { name: "还没有账户？邮箱注册", exact: true })
      .click();
    await p.locator("input[name=email]").fill("browser@example.test");
    await send(p);
    await p.locator("input[name=password]").fill("browser-password-123");
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await p.locator(".local-auth .connect").click();
    const id = await signedIn(p);
    console.log(
      "PASS email registration UI via actual local SMTP and HttpOnly session, mobile no overflow",
    );
    const q = await open();
    await q.getByRole("button", { name: "邮箱验证码", exact: true }).click();
    await q.locator("input[name=email]").fill("browser@example.test");
    await send(q);
    await q.locator(".local-auth .connect").click();
    assert.equal(await signedIn(q), id);
    console.log("PASS email one-time-code login UI");
    const r = await open();
    await r
      .getByRole("button", {
        name: "忘记密码？通过已绑定邮箱找回",
        exact: true,
      })
      .click();
    await r.locator("input[name=email]").fill("browser@example.test");
    await send(r);
    await r.locator("input[name=password]").fill("changed-password-456");
    const reset = r.waitForResponse((res) =>
      res.url().endsWith("/v1/auth/password/reset"),
    );
    await r.locator(".local-auth .connect").click();
    assert.equal((await reset).status(), 200);
    await r.locator("input[name=username]").waitFor();
    assert.equal((await p.request.get(base + "/v1/me")).status(), 401);
    assert.equal((await q.request.get(base + "/v1/me")).status(), 401);
    await r.locator("input[name=username]").fill("browser@example.test");
    await r.locator("input[name=password]").fill("changed-password-456");
    await r.locator(".local-auth .connect").click();
    assert.equal(await signedIn(r), id);
    console.log(
      "PASS reset-password UI, old sessions revoked, bound-email/password login",
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
    await new Promise((r) => smtp.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
})();
