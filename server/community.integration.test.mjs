import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
test("community HTTP contracts: anonymous privacy, account sessions, reports, unread, funds, tasks and durable restart", async () => {
  const dir = mkdtempSync(tmpdir() + "/sw-community-http-"),
    base = "http://127.0.0.1:39142";
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["server/index.mjs"], {
      env: {
        ...process.env,
        PORT: "39142",
        DATA_DIR: dir,
        SEED_DEMO: "0",
        ADMIN_USERNAMES: "",
        AUTO_FIRST_ADMIN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/health")).ok) return;
      } catch {}
      if (child.exitCode !== null) throw Error("startup failed");
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error("startup timeout");
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
  };
  const call = async (path, method = "GET", body, token) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, data };
  };
  const register = async (username) => {
    assert.equal(
      (
        await call("/v1/auth/register", "POST", {
          username,
          password: "testing-password-123",
        })
      ).status,
      201,
    );
    return (
      await call("/v1/auth/login", "POST", {
        username,
        password: "testing-password-123",
      })
    ).data;
  };
  try {
    await start();
    const a = await register("Alice"),
      b = await register("Bob"),
      t = a.token;
    let s = b.token;
    assert.equal(
      (await call("/v1/me/check-in", "POST", {}, t)).data.dennyGained,
      10,
    );
    assert.equal(
      (await call("/v1/me/check-in", "POST", {}, t)).data.dennyGained,
      0,
    );
    const made = await call(
      "/v1/posts",
      "POST",
      {
        title: "Anonymous test",
        body: "safe body",
        isAnonymous: true,
        externalVideos: ["BV1xx411c7mD"],
      },
      t,
    );
    assert.equal(made.status, 201);
    const id = made.data.id;
    assert.equal(
      (await call(`/v1/posts/${id}/publish`, "POST", {}, t)).status,
      200,
    );
    const pub = await call(`/v1/posts/${id}`, "GET", undefined, s);
    assert.equal(pub.status, 200);
    assert.equal(pub.data.author.anonymous, true);
    assert.equal(pub.data.authorId, "");
    assert.equal(pub.data.externalVideos[0].provider, "bilibili");
    assert.ok(!JSON.stringify(pub.data).includes(a.user.id));
    await call(`/v1/users/${a.user.id}/follow`, "PUT", {}, s);
    assert.equal(
      (await call("/v1/feed/following", "GET", undefined, s)).data.items.length,
      0,
    );
    assert.equal(
      (await call(`/v1/users/${a.user.id}/posts`, "GET", undefined, s)).data
        .items.length,
      0,
    );
    const comment = await call(
      `/v1/posts/${id}/comments`,
      "POST",
      { body: "anonymous comment", isAnonymous: true },
      s,
    );
    assert.equal(comment.status, 201);
    assert.equal(comment.data.author.anonymous, true);
    assert.equal(comment.data.authorId, "");
    assert.equal(
      (await call(`/v1/comments/${comment.data.id}/pin`, "PUT", {}, s)).status,
      403,
    );
    assert.equal(
      (await call(`/v1/comments/${comment.data.id}/pin`, "PUT", {}, t)).status,
      200,
    );
    assert.equal(
      (await call(`/v1/posts/${id}/comments`, "GET", undefined, t)).data
        .items[0].isPinned,
      true,
    );
    assert.equal(
      (await call("/v1/me/notifications", "GET", undefined, t)).data.unread,
      1,
    );
    assert.equal(
      (await call("/v1/me/notifications", "GET", undefined, s)).data.items
        .length,
      0,
    );
    const report = await call(
      "/v1/reports",
      "POST",
      { targetType: "post", targetId: id, reason: "test" },
      s,
    );
    assert.equal(report.status, 200);
    assert.equal(
      (await call("/v1/admin/reports", "GET", undefined, s)).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/v1/admin/reports/" + report.data.id,
          "PATCH",
          { state: "dismissed" },
          t,
        )
      ).status,
      200,
    );
    await call("/v1/me/reads", "POST", { postIds: [id] }, s);
    assert.equal(
      (await call("/v1/feed/unread", "GET", undefined, s)).data.items.length,
      0,
    );
    const task = await call("/v1/me/tasks", "POST", { title: "durable" }, t);
    assert.equal(task.status, 200);
    assert.equal(
      (await call("/v1/me/tasks/" + task.data.id, "DELETE", undefined, s))
        .status,
      404,
    );
    const transfer = { peerId: b.user.id, amount: 5, clientId: "http-replay" };
    assert.equal(
      (await call("/v1/me/transfers", "POST", transfer, t)).status,
      200,
    );
    await call("/v1/me/transfers", "POST", transfer, t);
    assert.equal(
      (await call("/v1/me/wallet", "GET", undefined, t)).data.balance,
      5,
    );
    assert.equal(
      (await call("/v1/me/wallet", "GET", undefined, s)).data.balance,
      5,
    );
    assert.equal(
      (await call(`/v1/users/${b.user.id}/block`, "PUT", {}, t)).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/v1/me/transfers",
          "POST",
          { ...transfer, clientId: "blocked" },
          t,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          `/v1/dm/friends/${b.user.id}`,
          "PATCH",
          { blocked: false },
          t,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/v1/me/blocks", "GET", undefined, t)).data.items.length,
      0,
    );
    assert.equal(
      (await call(`/v1/dm/friends/${b.user.id}`, "PATCH", { blocked: true }, t))
        .status,
      200,
    );
    assert.equal(
      (await call("/v1/me/blocks", "GET", undefined, t)).data.items[0].id,
      b.user.id,
    );
    assert.equal(
      (
        await call(
          "/v1/me/transfers",
          "POST",
          { peerId: a.user.id, amount: 1, clientId: "reverse-blocked" },
          s,
        )
      ).status,
      403,
    );
    await call(`/v1/users/${b.user.id}/block`, "DELETE", undefined, t);
    assert.equal(
      (await call(`/v1/admin/users/${b.user.id}`, "PATCH", { denny: 9 }, t))
        .status,
      200,
    );
    const adjustment = (
      await call("/v1/me/denny-logs", "GET", undefined, s)
    ).data.items.find((x) => x.action === "admin_adjust");
    assert.equal(adjustment.amount, 4);
    assert.equal(adjustment.balance, 9);
    await call(`/v1/admin/users/${b.user.id}`, "PATCH", { banned: true }, t);
    assert.equal(
      (
        await call(
          "/v1/me/transfers",
          "POST",
          { ...transfer, clientId: "banned" },
          t,
        )
      ).status,
      403,
    );
    await call(`/v1/admin/users/${b.user.id}`, "PATCH", { banned: false }, t);
    assert.equal(
      (await call("/v1/me/wallet", "GET", undefined, s)).status,
      401,
    );
    s = (
      await call("/v1/auth/login", "POST", {
        username: "Bob",
        password: "testing-password-123",
      })
    ).data.token;
    const sessions = await call("/v1/me/sessions", "GET", undefined, t);
    assert.ok(sessions.data.items[0].current);
    assert.ok(!JSON.stringify(sessions).includes(t));
    assert.ok(!JSON.stringify(pub.data.author).includes("denny"));
    await stop();
    await start();
    assert.equal(
      (await call("/v1/me/wallet", "GET", undefined, t)).data.balance,
      5,
    );
    assert.equal(
      (await call("/v1/me/tasks", "GET", undefined, t)).data.items[0].title,
      "durable",
    );
    assert.equal(
      (await call(`/v1/posts/${id}`, "DELETE", undefined, s)).status,
      403,
    );
    assert.equal(
      (await call(`/v1/posts/${id}`, "DELETE", undefined, t)).status,
      200,
    );
    assert.equal(
      (await call(`/v1/posts/${id}`, "GET", undefined, s)).status,
      404,
    );
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
