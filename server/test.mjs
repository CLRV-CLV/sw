import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import WebSocket from "ws";
const dir = mkdtempSync(`${tmpdir()}/ik-test-`);
const child = spawn(process.execPath, ["server/index.mjs"], {
  env: { ...process.env, PORT: "39123", DATA_DIR: dir },
  stdio: ["ignore", "pipe", "pipe"],
});
let ws;
try {
  await new Promise((resolve, reject) => {
    child.on("exit", () => reject(Error("server exited")));
    const start = Date.now();
    const t = setInterval(async () => {
      try {
        await fetch("http://localhost:39123/health");
        clearInterval(t);
        resolve();
      } catch {
        if (Date.now() - start > 5000) {
          clearInterval(t);
          reject(Error("startup timeout"));
        }
      }
    }, 50);
  });
  const call = async (p, b, token, method, headers = {}) => {
    const r = await fetch(`http://localhost:39123${p}`, {
      method: method || (b ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: b ? JSON.stringify(b) : undefined,
    });
    return [r.status, await r.json()];
  };
  assert.equal((await call("/v1/me"))[0], 401);
  assert.equal(
    (
      await call("/v1/auth/register", {
        username: "测试绳匠",
        password: "short",
      })
    )[0],
    400,
  );
  assert.equal(
    (
      await call("/v1/auth/register", {
        username: "测试绳匠",
        password: "safe-password-123",
      })
    )[0],
    201,
  );
  assert.equal(
    (
      await call("/v1/auth/register", {
        username: "测试绳匠",
        password: "safe-password-123",
      })
    )[0],
    409,
  );
  assert.equal(
    (
      await call("/v1/auth/login", { username: "测试绳匠", password: "bad" })
    )[0],
    401,
  );
  const [status, login] = await call("/v1/auth/login", {
    username: "测试绳匠",
    password: "safe-password-123",
  });
  assert.equal(status, 200);
  const token = login.token;
  const cookieResponse = await fetch("http://localhost:39123/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "测试绳匠",
      password: "safe-password-123",
    }),
  });
  assert.match(cookieResponse.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(
    (
      await call("/v1/me", null, null, "GET", {
        Cookie: cookieResponse.headers.get("set-cookie").split(";")[0],
      })
    )[0],
    200,
  );
  assert.equal(
    (await call("/v1/posts", { title: "新委托", body: "hello" }))[0],
    401,
  );
  const [created, p] = await call(
    "/v1/posts",
    { title: "新委托", body: "hello" },
    token,
  );
  assert.equal(created, 201);
  assert.equal((await call(`/v1/posts/${p.id}`))[0], 404);
  assert.equal((await call(`/v1/posts/${p.id}/comments`))[0], 404);
  assert.ok(!(await call("/v1/feed/hot"))[1].items.some((i) => i.id === p.id));
  const edit = await call(
    `/v1/posts/${p.id}/draft`,
    { title: "新委托·修订", body: "hello world" },
    token,
    "PUT",
  );
  assert.equal(edit[0], 200);
  ws = new WebSocket("ws://localhost:39123/v1/realtime");
  await new Promise((resolve, reject) => {
    ws.once("message", (d) => {
      try {
        assert.equal(JSON.parse(d).op, "hello");
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", reject);
  });
  const event = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("event timeout")), 3000);
    ws.once("message", (d) => {
      clearTimeout(timeout);
      resolve(JSON.parse(d));
    });
  });
  assert.equal((await call(`/v1/posts/${p.id}/publish`, {}, token))[0], 200);
  assert.equal((await event).t, "post.published");
  assert.equal((await call(`/v1/posts/${p.id}`))[1].body, "hello world");
  const [, comment] = await call(
    `/v1/posts/${p.id}/comments`,
    { body: "测试评论" },
    token,
  );
  const [, reply] = await call(
    `/v1/posts/${p.id}/comments`,
    { body: "测试回复", parentId: comment.id },
    token,
  );
  assert.equal(
    (await call(`/v1/posts/${p.id}/comments`))[1].items[0].replies[0].id,
    reply.id,
  );
  assert.equal(
    (
      await call(
        `/v1/posts/${p.id}/comments`,
        { body: "坏回复", parentId: "missing" },
        token,
      )
    )[0],
    400,
  );
  for (let n = 0; n < 2; n++)
    assert.equal(
      (await call(`/v1/posts/${p.id}/like`, null, token, "PUT"))[1].likeCount,
      1,
    );
  assert.equal(
    (await call(`/v1/posts/${p.id}/like`, null, token, "DELETE"))[1].likeCount,
    0,
  );
  assert.equal(
    (await call(`/v1/posts/${p.id}/favorite`, null, token, "PUT"))[1].favorited,
    true,
  );
  assert.equal(
    (await call("/v1/me/favorites", null, token))[1].items[0].post.id,
    p.id,
  );
  const [, page] = await call("/v1/posts?limit=2");
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  assert.equal(
    (
      await call("/v1/auth/logout", {}, token, "POST", {
        Origin: "https://evil.invalid",
      })
    )[0],
    403,
  );
  await call("/v1/auth/register", {
    username: "其他绳匠",
    password: "safe-password-123",
  });
  const [, other] = await call("/v1/auth/login", {
    username: "其他绳匠",
    password: "safe-password-123",
  });
  assert.equal(
    (
      await call(
        `/v1/posts/${p.id}/draft`,
        { title: "偷改", body: "no" },
        other.token,
        "PUT",
      )
    )[0],
    403,
  );
  await call("/v1/auth/logout", {}, token);
  assert.equal((await call("/v1/me", null, token))[0], 401);
  console.log(
    "PASS: accounts, cookies, draft privacy/edit/publish, websocket broadcast, comments/replies, idempotent likes, favorites, pagination, CSRF, ownership, logout",
  );
} finally {
  ws?.terminate();
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));
  rmSync(dir, { recursive: true, force: true });
}
