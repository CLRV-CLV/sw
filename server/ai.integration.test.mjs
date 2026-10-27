import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { dossierFields, refusal } from "./ai/policy.mjs";
test("resident AI HTTP end-to-end: New API transport, first admin, private chat, safe draft author and restart persistence", async () => {
  const dir = mkdtempSync(tmpdir() + "/ik-ai-http-"),
    base = "http://127.0.0.1:39129";
  let child;
  const upstreamCalls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer integration-secret");
    upstreamCalls.push(b);
    const system = b.messages[0].content;
    let result;
    if (system.includes("审查器"))
      result = { allowed: !b.messages.at(-1).content.includes("编程") };
    else if (system.includes("撰写本站绳网文章"))
      result = {
        title: "休息片刻",
        body: "这是一段艾莲角色的虚构日常，和同伴一起在下班后休息，补充一点糖分，然后回到普通的学生生活。".repeat(
          10,
        ),
      };
    else result = { reply: "下班以后，和朋友待一会儿就很好。糖果？我有带。" };
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
  async function start() {
    child = spawn(process.execPath, ["server/index.mjs"], {
      env: {
        ...process.env,
        AI_SEED_CATALOG: "1",
        DATA_DIR: dir,
        PORT: "39129",
        AI_ENABLED: "0",
        AI_ALLOW_HTTP: "1",
        ADMIN_USERNAMES: "",
        AI_API_KEY: "",
        AI_CONFIG_SECRET: "",
        AUTO_FIRST_ADMIN: "1",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/health")).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error("startup");
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
  }
  async function call(path, method = "GET", body, token) {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return [r.status, await r.json()];
  }
  async function done(id, token) {
    for (let i = 0; i < 100; i++) {
      const r = (await call(`/v1/ai/jobs/${id}`, "GET", undefined, token))[1];
      if (["done", "failed"].includes(r.state)) return r;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("job");
  }
  try {
    upstream.listen(39130, "127.0.0.1");
    await once(upstream, "listening");
    await start();
    const users = [];
    for (const username of ["owner", "alice", "bob"]) {
      assert.equal(
        (
          await call("/v1/auth/register", "POST", {
            username,
            password: "test-password-123",
          })
        )[0],
        201,
      );
      users.push(
        (
          await call("/v1/auth/login", "POST", {
            username,
            password: "test-password-123",
          })
        )[1],
      );
    }
    const [a, u, b] = users;
    assert.equal(a.user.role, "admin");
    assert.equal(
      (await call("/v1/admin/ai/config", "GET", undefined, u.token))[0],
      403,
    );
    assert.equal(
      (
        await call(
          "/v1/admin/ai/config",
          "PATCH",
          {
            enabled: true,
            baseUrl: "http://127.0.0.1:39130/v1",
            model: "fixture",
            apiKey: "integration-secret",
          },
          a.token,
        )
      )[0],
      200,
    );
    // Explicit fixture: no claim that live Wiki/model results are present in this test.
    const dossier = Object.fromEntries(
      dossierFields.map((k) => [
        k,
        `${k}：艾莲是维多利亚家政的成员，同时在新艾利都上学，重视休息和同伴。`.repeat(
          12,
        ),
      ]),
    );
    assert.equal(
      (
        await call(
          "/v1/admin/ai/roles/ellen-joe/wiki-text",
          "PUT",
          {
            text: "Explicit integration fixture, not a live Wiki result. ".repeat(
              40,
            ),
            part: "",
          },
          a.token,
        )
      )[0],
      200,
    );
    assert.equal(
      (
        await call(
          "/v1/admin/ai/roles/ellen-joe",
          "PATCH",
          { dossier },
          a.token,
        )
      )[0],
      200,
    );

    assert.equal(
      (
        await call(
          "/v1/admin/ai/roles/ellen-joe",
          "PATCH",
          { approved: true },
          a.token,
        )
      )[0],
      200,
    );
    assert.equal(
      (
        await call(
          "/v1/admin/ai/roles/ellen-joe",
          "PATCH",
          { enabled: true },
          a.token,
        )
      )[0],
      200,
    );
    const turn = (
      await call(
        "/v1/ai/chats/ellen-joe/turns",
        "POST",
        { content: "下班后你如何休息？", clientId: "http-turn" },
        u.token,
      )
    )[1];
    assert.equal((await done(turn.id, u.token)).state, "done");
    assert.equal(
      (await call(`/v1/ai/jobs/${turn.id}`, "GET", undefined, b.token))[0],
      404,
    );
    assert.equal(
      (await call("/v1/ai/chats/ellen-joe", "GET", undefined, b.token))[1].items
        .length,
      0,
    );
    const off = (
      await call(
        "/v1/ai/chats/ellen-joe/turns",
        "POST",
        { content: "帮我编程", clientId: "off-topic" },
        u.token,
      )
    )[1];
    assert.equal((await done(off.id, u.token)).result.reply, refusal);
    const article = (
        await call(
          "/v1/admin/ai/articles",
          "POST",
          {
            roleId: "ellen-joe",
            command: "写一篇你下班后的角色同人日常",
            clientId: "article-http",
          },
          a.token,
        )
      )[1],
      draft = await done(article.id, a.token);
    assert.equal(draft.state, "done");
    const id = draft.result.postId;
    assert.equal((await call(`/v1/posts/${id}`))[0], 404);
    assert.equal(
      (
        await call(
          `/v1/admin/posts/${id}`,
          "PATCH",
          { status: "published" },
          a.token,
        )
      )[0],
      200,
    );
    const post = (await call(`/v1/posts/${id}`))[1];
    assert.equal(post.aiGenerated, true);
    assert.match(post.author.name, /艾莲.*AI/);
    assert.equal((await call("/v1/users/ai:ellen-joe"))[0], 200);
    assert.ok(
      upstreamCalls.every(
        (c) => !JSON.stringify(c.messages).includes("integration-secret"),
      ),
    );
    await stop();
    await start();
    assert.equal(
      (await call("/v1/ai/chats/ellen-joe", "GET", undefined, u.token))[1].items
        .length,
      4,
    );
    assert.equal(
      (await call("/v1/admin/ai/config", "GET", undefined, a.token))[1]
        .hasApiKey,
      true,
    );
    const again = (
      await call(
        "/v1/ai/chats/ellen-joe/turns",
        "POST",
        { content: "今天和同伴相处得怎么样？", clientId: "restart" },
        u.token,
      )
    )[1];
    assert.equal((await done(again.id, u.token)).state, "done");
  } finally {
    await stop();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
