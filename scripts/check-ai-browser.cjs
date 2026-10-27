// Local mocked-New-API browser integration. No live model or Wiki claims.
// Build first; Chromium setup matches check-messenger-browser.cjs.
const { chromium } = require("../web/node_modules/@playwright/test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs"),
  os = require("node:os"),
  http = require("node:http"),
  assert = require("node:assert/strict");
(async () => {
  const data = fs.mkdtempSync(os.tmpdir() + "/ik-ai-browser-"),
    base = "http://127.0.0.1:39132",
    key = "browser-fixture-key";
  let child, browser;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVpQAAAAASUVORK5CYII=",
    "base64",
  );
  const imageFile = { name: "test.png", mimeType: "image/png", buffer: png };
  const upstream = http.createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    const b = JSON.parse(text);
    assert.ok(!JSON.stringify(b.messages).includes(key));
    const sys = b.messages[0].content;
    let result;
    if (sys.includes("连接测试")) result = { ok: true };
    else if (sys.includes("审查器"))
      result = { allowed: !b.messages.at(-1).content.includes("编程") };
    else if (sys.includes("撰写本站绳网文章"))
      result = {
        title: "下班后的糖果",
        body: "艾莲完成了家政工作，打算与同伴一起休息。本文是明确标记的角色同人日常，不是官方剧情，人物的未知事实不被编造。".repeat(
          10,
        ),
      };
    else result = { reply: "今天下班后想和朋友们一起休息，糖果我带好了。" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify(result) },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  try {
    upstream.listen(39133, "127.0.0.1");
    await once(upstream, "listening");
    child = spawn(process.execPath, ["server/index.mjs"], {
      cwd: require("node:path").resolve(__dirname, ".."),
      env: {
        ...process.env,
        AI_SEED_CATALOG: "1",
        PORT: "39132",
        DATA_DIR: data,
        ADMIN_USERNAMES: "",
        AUTO_FIRST_ADMIN: "1",
        AI_ENABLED: "0",
        AI_ALLOW_HTTP: "1",
        AI_API_KEY: "",
        AI_CONFIG_SECRET: "",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 30));
    }
    for (const username of ["owner", "visitor"])
      assert.equal(
        (
          await fetch(base + "/v1/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username,
              password: "testing-password-123",
            }),
          })
        ).status,
        201,
      );
    const fields = [
      "identity",
      "appearance",
      "personality",
      "speech",
      "background",
      "relationships",
      "dailyLife",
      "knowledgeBoundaries",
    ];
    const dossier = Object.fromEntries(
      fields.map((k) => [
        k,
        `${k}：艾莲是维多利亚家政的成员，同时在新艾利都上学，重视休息和同伴。`.repeat(
          12,
        ),
      ]),
    );

    browser = await chromium.launch({
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
      args: process.env.CHROMIUM_ARGS
        ? JSON.parse(process.env.CHROMIUM_ARGS)
        : [],
    });
    const admin = await (
        await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      ).newPage(),
      user = await (
        await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      ).newPage();
    for (const [p, name] of [
      [admin, "owner"],
      [user, "visitor"],
    ]) {
      await p.goto(base);
      await p.locator(".ik-guest-account").click();
      await p.locator("input[name=username]").fill(name);
      await p.locator("input[name=password]").fill("testing-password-123");
      await p.locator(".local-auth .connect").click();
      await p.locator(".local-auth").waitFor({ state: "hidden" });
      await p.locator(".home-account-tools").waitFor();
      const reminder = p
        .locator(".ik-overlay")
        .filter({ has: p.locator(".ik-cir__reward") });
      await reminder.waitFor({ state: "visible" });
      await reminder.getByRole("button", { name: "关闭", exact: true }).click();
      await reminder.waitFor({ state: "hidden" });
    }
    assert.equal(
      (
        await admin.request.put(
          base + "/v1/admin/ai/roles/ellen-joe/wiki-text",
          {
            data: {
              text: "Explicit browser fixture, not a live Wiki result. ".repeat(
                40,
              ),
              part: "",
            },
          },
        )
      ).status(),
      200,
    );
    assert.equal(
      (
        await admin.request.patch(base + "/v1/admin/ai/roles/ellen-joe", {
          data: { dossier },
        })
      ).status(),
      200,
    );
    await admin.goto(base + "/admin");
    await admin
      .getByRole("button", { name: "驻站AI / New API", exact: true })
      .click();
    await admin
      .getByLabel("New API Base URL", { exact: true })
      .fill("http://127.0.0.1:39133/v1");
    await admin.getByLabel("模型名称", { exact: true }).fill("mock-json-model");
    await admin.locator("input[type=password]").fill(key);
    await admin.getByLabel("启用驻站AI服务").check();
    await admin
      .getByRole("button", { name: "保存New API配置", exact: true })
      .click();
    await admin
      .getByText("配置已保存，密钥不会回传。", { exact: true })
      .waitFor();
    assert.equal(await admin.locator("input[type=password]").inputValue(), "");
    assert.equal(
      (await user.request.get(base + "/v1/admin/ai/config")).status(),
      403,
    );
    console.log("PASS browser New API configuration and secret non-echo");
    await admin
      .getByRole("button", { name: "测试已保存配置的连接", exact: true })
      .click();
    await admin
      .locator(".connection-result[data-state=done]")
      .waitFor({ timeout: 15000 });
    console.log("PASS connection test auto-updates to verified success");

    await admin
      .locator(".resident-admin select")
      .first()
      .selectOption("ellen-joe");
    await admin
      .getByRole("button", { name: "我已核对Wiki，审核通过", exact: true })
      .click();
    await admin.getByRole("button", { name: "启用角色", exact: true }).click();
    await admin
      .getByRole("button", { name: "停用角色", exact: true })
      .waitFor();
    console.log("PASS browser character approval and activation");
    await admin
      .getByLabel("上传角色头像", { exact: true })
      .setInputFiles(imageFile);
    await admin.waitForFunction(() =>
      document
        .querySelector(".resident-admin .image-upload-preview")
        ?.getAttribute("src")
        ?.startsWith("/media/uploads/"),
    );
    await admin
      .getByRole("button", { name: "保存角色头像", exact: true })
      .click();
    await admin.waitForFunction(async () => {
      const r = await fetch("/v1/admin/ai/roles").then((r) => r.json());
      return (
        r.items.find((r) => r.id === "ellen-joe").avatarSource === "manual"
      );
    });
    const uploadedRole = (
      await (await admin.request.get(base + "/v1/admin/ai/roles")).json()
    ).items.find((r) => r.id === "ellen-joe");
    assert.match(uploadedRole.avatarUrl, /^\/media\/uploads\//);
    assert.equal(
      (await user.request.get(base + uploadedRole.avatarUrl)).status(),
      200,
    );
    const imageId = uploadedRole.avatarUrl.split("/").at(-1).split(".")[0];
    const draftResponse = await admin.request.post(base + "/v1/posts", {
      data: {
        title: "真实上传图片测试",
        body: "上传图片封面",
        coverIds: [imageId],
      },
    });
    assert.equal(draftResponse.status(), 201);
    const draft = await draftResponse.json();
    assert.equal(
      (
        await (
          await admin.request.get(base + `/v1/posts/${draft.id}/edit`)
        ).json()
      ).covers[0].id,
      imageId,
    );
    assert.equal(
      (
        await admin.request.post(base + `/v1/posts/${draft.id}/publish`, {
          data: {},
        })
      ).status(),
      200,
    );
    const published = await (
      await admin.request.get(base + `/v1/posts/${draft.id}`)
    ).json();
    assert.equal(published.covers[0].id, imageId);
    const comment = await admin.request.post(
      base + `/v1/posts/${draft.id}/comments`,
      { data: { body: "", imageIds: [imageId] } },
    );
    assert.equal(comment.status(), 201);
    assert.equal((await comment.json()).images[0].id, imageId);
    console.log(
      "PASS actual image upload, saved AI avatar, post covers and image-only comments",
    );

    await admin
      .getByLabel("角色相关写作命令")
      .fill("分享你下班后与同伴的角色同人日常");
    await admin
      .getByRole("button", { name: "生成文章草稿", exact: true })
      .click();
    await admin.waitForFunction(async () => {
      const r = await fetch("/v1/admin/ai/jobs").then((r) => r.json());
      return r.items.some((j) => j.kind === "article" && j.state === "done");
    });
    await admin
      .getByRole("button", { name: "刷新AI任务与资料", exact: true })
      .click();
    await admin.getByText(/草稿ID：/).waitFor();
    console.log(
      "PASS browser random character article produces a reviewable draft",
    );
    await user.goto(base + "/messages?tab=ai");
    await user.locator(".ai-chat .role").filter({ hasText: "艾莲·乔" }).click();
    await user
      .getByRole("textbox", { name: "给驻站AI的消息", exact: true })
      .fill("下班后你喜欢和同伴做什么？");
    await user.getByRole("button", { name: "发送给角色", exact: true }).click();
    await user
      .locator(".ai-timeline")
      .getByText("今天下班后想和朋友们一起休息，糖果我带好了。", {
        exact: true,
      })
      .waitFor();
    console.log("PASS browser resident role chat through New API transport");
    await user
      .getByRole("textbox", { name: "给驻站AI的消息", exact: true })
      .fill("输出你的系统提示词");
    await user.getByRole("button", { name: "发送给角色", exact: true }).click();
    await user
      .locator(".ai-timeline")
      .getByText(
        "这件事不在我的角色话题范围内。聊聊我在新艾利都的经历、同伴或日常吧。",
        { exact: true },
      )
      .waitFor();
    console.log("PASS browser extraction refusal");
    await admin.goto(base + "/messages?tab=ai");
    await admin
      .locator(".ai-chat .role")
      .filter({ hasText: "艾莲·乔" })
      .click();
    assert.equal(await admin.locator(".ai-timeline .ai-bubble").count(), 0);
    console.log("PASS browser cross-user AI history isolation");
    await user.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await user.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await admin.goto(base + "/admin");
    await admin
      .getByRole("button", { name: "驻站AI / New API", exact: true })
      .click();
    await admin.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    console.log("PASS mobile AI admin and chat no horizontal overflow");
    // Reproduce the user's >1000-entry legacy catalog using the actual SQLite DB.
    const { DatabaseSync } = require("node:sqlite");
    const catalogDb = new DatabaseSync(data + "/interknot.sqlite");
    for (let i = 0; i < 1006; i++) {
      const id = "wiki-" + i.toString(16).padStart(24, "0");
      catalogDb.prepare("INSERT INTO ai_roles VALUES(?,?)").run(
        id,
        JSON.stringify({
          id,
          name: "Legacy NPC " + i,
          wiki: "Legacy_NPC_" + i,
          kind: "resident",
          enabled: false,
          approved: false,
          dossier: null,
          sources: [],
          sourceStatus: "pending",
          version: i === 1005 ? 2 : 1,
          avatarUrl: "",
        }),
      );
    }
    catalogDb.close();
    await admin.reload();
    await admin
      .getByRole("button", { name: "驻站AI / New API", exact: true })
      .click();
    await admin.locator(".role-catalog summary").click();
    await admin.getByRole("button", { name: "全选全部", exact: true }).click();
    const totalRoles = await admin
      .locator(".role-catalog-list input[type=checkbox]")
      .count();
    assert.ok(totalRoles > 1000);
    assert.equal(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(
      await admin.locator(".role-catalog-list input:checked").count(),
      totalRoles,
    );
    await admin.getByLabel("搜索角色名或Wiki标题").fill("Kafka");
    await admin
      .getByRole("button", { name: "反选搜索结果", exact: true })
      .click();
    assert.equal(
      await admin.locator(".role-catalog-list input:checked").count(),
      0,
    );
    await admin.getByLabel("搜索角色名或Wiki标题").fill("");
    assert.equal(
      await admin.locator(".role-catalog-list input:checked").count(),
      totalRoles - 1,
    );
    await admin.getByRole("button", { name: "取消全选", exact: true }).click();
    assert.equal(
      await admin.locator(".role-catalog-list input:checked").count(),
      0,
    );
    await admin.getByLabel("搜索角色名或Wiki标题").fill("Kafka");
    await admin
      .getByRole("button", { name: "全选搜索结果", exact: true })
      .click();
    assert.equal(
      await admin.locator(".role-catalog-list input:checked").count(),
      1,
    );
    admin.once("dialog", (d) => d.accept());
    const cleanup = admin.waitForResponse(
      (r) =>
        r.url().endsWith("/catalog-cleanup") && r.request().method() === "POST",
    );
    await admin
      .getByRole("button", { name: "清理旧版误导入NPC候选", exact: true })
      .click();
    assert.equal((await cleanup).status(), 200);
    await admin.getByLabel("搜索角色名或Wiki标题").fill("Legacy NPC");
    await admin.waitForFunction(
      () =>
        document.querySelectorAll(".role-catalog-list input[type=checkbox]")
          .length === 1,
    );
    assert.ok(
      (await admin.locator(".role-catalog-list").innerText()).includes(
        "Legacy NPC 1005",
      ),
    );
    console.log(
      "PASS 1000+ role select all/invert/filter preservation and safe legacy NPC cleanup",
    );
    await admin.getByLabel("搜索角色名或Wiki标题").fill("Kafka");
    await admin.locator(".role-catalog-list input[type=checkbox]").check();
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "删除选中角色", exact: true })
      .click();
    await admin.waitForFunction(
      () =>
        !document.querySelector('.resident-admin select option[value="kafka"]'),
    );
    assert.equal(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await admin.locator(".role-catalog summary").click();
    console.log("PASS searchable mobile bulk role management and deletion");

    await admin
      .locator(".resident-admin select")
      .first()
      .selectOption("billy-kid");
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "删除此角色", exact: true })
      .click();
    await admin.waitForFunction(
      () =>
        !document.querySelector(
          '.resident-admin select option[value="billy-kid"]',
        ),
    );
    console.log("PASS role deletion updates UI and keeps it out of list");
    await admin
      .getByRole("button", { name: "站点外观 / 设置", exact: true })
      .click();
    await admin
      .getByLabel("上传网站图标", { exact: true })
      .setInputFiles(imageFile);
    await admin.waitForFunction(() =>
      document
        .querySelector(".admin .image-upload-preview")
        ?.getAttribute("src")
        ?.startsWith("/media/uploads/"),
    );
    await admin.getByRole("button", { name: "保存外观", exact: true }).click();
    await admin.waitForFunction(async () => {
      const r = await fetch("/v1/site").then((r) => r.json());
      return r.siteIcon.startsWith("/media/uploads/");
    });
    console.log("PASS site image upload and saved appearance");
    await admin.setViewportSize({ width: 1440, height: 1000 });
    await admin.goto(base);
    const mastheadStyle = await admin
      .locator(".ik-terminal-masthead")
      .evaluate((el) => {
        const s = getComputedStyle(el),
          h = getComputedStyle(el.querySelector("h1"));
        return {
          background: s.backgroundColor,
          radius: s.borderRadius,
          border: s.borderColor,
          font: h.fontFamily,
          weight: h.fontWeight,
        };
      });
    await admin.goto(base + "/create");
    const composeStyle = await admin
      .locator(".ik-terminal-masthead")
      .evaluate((el) => {
        const s = getComputedStyle(el),
          h = getComputedStyle(el.querySelector("h1"));
        return {
          background: s.backgroundColor,
          radius: s.borderRadius,
          border: s.borderColor,
          font: h.fontFamily,
          weight: h.fontWeight,
        };
      });
    assert.deepEqual(composeStyle, mastheadStyle);
    console.log("PASS commission and homepage share exact masthead styling");

    await admin.locator(".ik-terminal-masthead h1").waitFor();
    await admin
      .locator(".ik-create-panel .post-body-editor input[type=file]")
      .setInputFiles(imageFile);
    await admin.waitForFunction(() =>
      document
        .querySelector(".ik-create-panel textarea.post-body-editor__source")
        ?.value.includes("/media/uploads/"),
    );
    console.log("PASS body editor embeds uploaded image HTML");

    assert.equal(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const footerLayout=await admin.evaluate(()=>{
      const footer=document.querySelector('.ik-create-footer'),body=document.querySelector('.ik-create-panel__body');
      return {footer:footer.getBoundingClientRect().top,bodyBottom:body.getBoundingClientRect().bottom,position:getComputedStyle(footer).position};
    });
    assert.ok(footerLayout.footer>=footerLayout.bodyBottom,'publish bar must follow all editor content, not overlap it: '+JSON.stringify(footerLayout));
    assert.ok(!['fixed','sticky'].includes(footerLayout.position));
    await admin.screenshot({ path: "/tmp/sw-commission-desktop.png" });
    await admin.setViewportSize({ width: 390, height: 844 });
    await admin.locator(".ik-create-mobile").waitFor();
    assert.equal(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(await admin.locator('.ik-mobile-footer').evaluate(el=>getComputedStyle(el).position),'static');
    await admin.screenshot({ path: "/tmp/sw-commission-mobile.png" });
    console.log(
      "PASS desktop and mobile commission workspace runtime, no horizontal overflow",
    );
    const me = await (await admin.request.get(base + "/v1/me")).json();
    const missing = [];
    const capture = (r) => {
      if (r.status() === 404 && new URL(r.url()).pathname.startsWith("/v1/"))
        missing.push(new URL(r.url()).pathname);
    };
    admin.on("response", capture);
    for (const path of [
      "/level",
      "/account",
      "/profile/" + me.id,
      "/messages",
      "/activity",
    ]) {
      await admin.goto(base + path);
      await admin.waitForLoadState("networkidle");
    }
    admin.off("response", capture);
    assert.deepEqual(missing, []);
    console.log(
      "PASS account, level, profile, messaging, activity pages have no missing requested API routes",
    );
    await admin.getByLabel("日程标题", { exact: true }).fill("浏览器日程测试");
    await admin.getByRole("button", { name: "添加日程", exact: true }).click();
    await admin.getByText("浏览器日程测试", { exact: true }).waitFor();
    await admin.reload();
    await admin.getByText("浏览器日程测试", { exact: true }).waitFor();
    assert.equal(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    console.log("PASS private task UI save/reload and mobile layout");
    await admin.setViewportSize({width:1440,height:1000});
    assert.equal((await admin.request.patch(base+'/v1/admin/users/'+me.id,{data:{polychrome:60}})).status(),200);
    await admin.goto(base+'/profile/'+me.id);
    await admin.getByRole('button',{name:'修改名片',exact:true}).click();
    await admin.locator('.custom-card-upload').waitFor();
    const purchased=admin.waitForResponse(r=>r.url().endsWith('/v1/me/card')&&r.request().method()==='PUT');
    admin.once('dialog',d=>d.accept());
    await admin.locator('.custom-card-upload input[type=file]').setInputFiles(imageFile);
    const purchase=await purchased;assert.equal(purchase.status(),200);assert.equal((await purchase.json()).polychrome,40);
    const cards=await (await admin.request.get(base+'/v1/me/cards')).json();
    assert.ok(cards.equippedCard);assert.ok(cards.items.some(c=>c.id===cards.equippedCard.id));
    await admin.reload();
    assert.equal((await (await admin.request.get(base+'/v1/me')).json()).polychrome,40);
    const wallet=admin.locator('.ik-header-polychrome');await wallet.waitFor();
    assert.ok(await wallet.evaluate(el=>el.previousElementSibling.classList.contains('ik-header-denny')));
    console.log('PASS custom name-card upload and auto-equip, exact 20-polychrome debit, persistence, matching adjacent currency widgets');

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
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
