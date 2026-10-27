import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createProfiles } from "./site-data.mjs";
import {
  createCommunity,
  resolveVideo,
  validateVideos,
  checkInDay,
} from "./community.mjs";
import { createActivity } from "./activity.mjs";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT);INSERT INTO users VALUES('a','Alice'),('b','Bob');CREATE TABLE posts(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE comments(id TEXT PRIMARY KEY,postId TEXT,data TEXT);CREATE TABLE reactions(userId TEXT,targetId TEXT,kind TEXT,PRIMARY KEY(userId,targetId,kind));CREATE TABLE sessions(token TEXT PRIMARY KEY,userId TEXT,expires INTEGER);CREATE TABLE admin_audit(id TEXT,actor TEXT,action TEXT,target TEXT,createdAt TEXT);`,
  );
  const profiles = createProfiles(db),
    admin = { isAdmin: (u) => u?.id === "a" },
    publicUser = (u) => ({ id: u.id, name: u.username }),
    community = createCommunity(db, { profiles, admin, publicUser }),
    activity = createActivity(db);
  db.prepare("INSERT INTO posts VALUES(?,?)").run(
    "p",
    JSON.stringify({
      id: "p",
      title: "test",
      body: "post",
      authorId: "b",
      status: "published",
      tags: ["help"],
      publishedAt: new Date().toISOString(),
    }),
  );
  async function call(
    path,
    method = "GET",
    data = {},
    uid = "a",
    token = "token1",
  ) {
    const url = new URL(path, "http://test");
    let result;
    const ctx = {
      path: url.pathname,
      url,
      req: { method, socket: {} },
      user: uid ? { id: uid } : null,
      token,
      auth: () => {
        if (!uid) throw Object.assign(Error("login"), { status: 401 });
        return { id: uid };
      },
      body: async () => data,
      reply: (r) => {
        result = r;
      },
    };
    if (!(await activity.handler(ctx)))
      assert.equal(await community.handler(ctx), true);
    return result;
  }
  return { db, profiles, community, activity, call };
}
test("daily check-in is idempotent, XP sources capped, ledger and transfers are atomic and replay-safe", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.call("/v1/me/check-in", "POST", {}, null), {
      status: 401,
    });
    const first = await f.call("/v1/me/check-in", "POST");
    assert.equal(first.balance, 10);
    assert.equal(first.expGained, 6);
    assert.equal((await f.call("/v1/me/check-in", "POST")).dennyGained, 0);
    assert.equal(f.profiles.get("a").denny, 10);
    const money = await f.call("/v1/posts/p/denny", "POST");
    assert.equal(money.balance, 9);
    assert.equal(f.profiles.get("b").denny, 1);
    await assert.rejects(f.call("/v1/posts/p/denny", "POST"), { status: 409 });
    const tx = { peerId: "b", amount: 5, clientId: "once" };
    await f.call("/v1/me/transfers", "POST", tx);
    await f.call("/v1/me/transfers", "POST", tx);
    assert.equal(f.profiles.get("a").denny, 4);
    assert.equal(f.profiles.get("b").denny, 6);
    await assert.rejects(
      f.call("/v1/me/transfers", "POST", { ...tx, amount: 22 }),
      { status: 409 },
    );
    await assert.rejects(
      f.call("/v1/me/transfers", "POST", {
        ...tx,
        clientId: "poor",
        amount: 100,
      }),
      { status: 400 },
    );
    assert.equal(f.profiles.get("a").denny, 4);
    assert.equal(f.profiles.get("b").denny, 6);
    f.community.award("a", "createPost", 10);
    f.community.award("a", "createPost", 10);
    assert.equal(f.profiles.get("a").exp, 16);
    const logs = await f.call("/v1/me/denny-logs");
    assert.equal(logs.items.length, 3);
    const triple = await f.call("/v1/posts/p/triple", "POST");
    assert.equal(triple.dennyError, "ALREADY_GIVEN");
    assert.equal(triple.liked, true);
  } finally {
    f.db.close();
  }
});
test("following, blocks, reads, reports, pin ownership, cosmetics and session privacy are enforced", async () => {
  const f = fixture();
  try {
    await f.call("/v1/users/b/follow", "PUT");
    await f.call("/v1/users/b/follow", "PUT");
    assert.equal((await f.call("/v1/feed/following")).items.length, 1);
    await f.call("/v1/users/b/block", "PUT");
    assert.equal((await f.call("/v1/feed/following")).items.length, 0);
    assert.equal(
      (await f.call("/v1/me/relations?userIds=b"))[0].blocking,
      true,
    );
    await f.call("/v1/me/reads", "POST", { postIds: ["p"] });
    assert.equal(f.community.enrich({ id: "p" }, "a").isRead, true);
    await assert.rejects(
      f.call("/v1/me/reads", "POST", { postIds: ["hidden"] }),
      { status: 404 },
    );
    const report = { targetType: "post", targetId: "p", reason: "spam" };
    const r = await f.call("/v1/reports", "POST", report);
    assert.equal((await f.call("/v1/reports", "POST", report)).id, r.id);
    await assert.rejects(f.call("/v1/admin/reports", "GET", {}, "b"), {
      status: 403,
    });
    await f.call("/v1/admin/reports/" + r.id, "PATCH", { state: "resolved" });
    assert.equal(
      (await f.call("/v1/admin/reports")).items[0].state,
      "resolved",
    );
    await assert.rejects(
      f.call("/v1/me/profile/pinned-posts", "PUT", { postIds: ["p"] }),
      { status: 403 },
    );
    await f.call("/v1/me/profile/pinned-posts", "PUT", { postIds: ["p"] }, "b");
    assert.deepEqual(f.community.pins("b"), ["p"]);
    const avatar = (await f.call("/v1/me/avatars")).items[0];
    await f.call("/v1/me/avatars/equipped", "PUT", { avatarId: avatar.id });
    assert.equal(f.profiles.get("a").avatarUrl, avatar.image.url);
    f.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run("token1", "a", Date.now() + 60000);
    f.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run("token2", "a", Date.now() + 60000);
    f.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run("secret-b", "b", Date.now() + 60000);
    const sessions = await f.call("/v1/me/sessions");
    assert.equal(sessions.items.length, 2);
    assert.ok(!JSON.stringify(sessions).includes("token1"));
    const other = sessions.items.find((s) => !s.current);
    await assert.rejects(
      f.call("/v1/me/sessions/" + other.id, "DELETE", {}, "b", "secret-b"),
      { status: 404 },
    );
    await f.call("/v1/me/sessions/revoke-others", "POST");
    assert.equal((await f.call("/v1/me/sessions")).items.length, 1);
  } finally {
    f.db.close();
  }
});
test("private tasks and notifications isolate users, validate changes and survive module restart", async () => {
  const f = fixture();
  try {
    const t = await f.call("/v1/me/tasks", "POST", {
      title: "Work",
      dueAt: "2026-11-01T00:00:00Z",
    });
    assert.equal((await f.call("/v1/me/tasks")).items.length, 1);
    assert.equal(
      (await f.call("/v1/me/tasks", "GET", {}, "b")).items.length,
      0,
    );
    await assert.rejects(
      f.call("/v1/me/tasks/" + t.id, "PATCH", { done: true }, "b"),
      { status: 404 },
    );
    await f.call("/v1/me/tasks/" + t.id, "PATCH", { done: true });
    assert.equal((await f.call("/v1/me/tasks")).items[0].done, true);
    await assert.rejects(
      f.call("/v1/me/tasks", "POST", { title: "bad", done: "true" }),
      { status: 400 },
    );
    f.activity.notify("a", "comment", "new", "/post/p", "same");
    f.activity.notify("a", "comment", "new", "/post/p", "same");
    assert.equal((await f.call("/v1/me/notifications")).unread, 1);
    assert.equal(
      (await f.call("/v1/me/notifications", "GET", {}, "b")).items.length,
      0,
    );
    await f.call("/v1/me/notifications/read", "POST", { all: true });
    assert.equal((await f.call("/v1/me/notifications")).unread, 0);
    createActivity(f.db);
    assert.equal((await f.call("/v1/me/tasks")).items.length, 1);
    await f.call("/v1/me/tasks/" + t.id, "DELETE");
    assert.equal((await f.call("/v1/me/tasks")).items.length, 0);
  } finally {
    f.db.close();
  }
});
test("video parsing never trusts arbitrary embed URLs or claims fetched metadata", () => {
  assert.equal(resolveVideo("BV1xx411c7mD").metadataAvailable, false);
  assert.match(
    resolveVideo("https://www.bilibili.com/video/BV1xx411c7mD?p=2").embedUrl,
    /page=2/,
  );
  assert.throws(() => resolveVideo("https://evil.test/a"), { status: 400 });
  assert.throws(() => resolveVideo("javascript:alert(1)"), { status: 400 });
});

test("sign-in day turns at 04:00 Asia/Shanghai", () => {
  assert.equal(checkInDay(Date.parse("2026-10-26T19:59:59Z")), "2026-10-26");
  assert.equal(checkInDay(Date.parse("2026-10-26T20:00:00Z")), "2026-10-27");
});

test("video post input normalizes official players and rejects unsafe payloads", () => {
  const v = validateVideos([
    {
      provider: "bilibili",
      bvid: "BV1xx411c7mD",
      embedUrl: "javascript:alert(1)",
    },
  ])[0];
  assert.match(v.embedUrl, /^https:\/\/player.bilibili.com\//);
  assert.equal(v.metadataAvailable, false);
  assert.throws(
    () => validateVideos([{ provider: "evil", bvid: "BV1xx411c7mD" }]),
    { status: 400 },
  );
  assert.throws(() => validateVideos(["BV1xx411c7mD", "BV1xx411c7mD"]), {
    status: 400,
  });
  assert.throws(
    () => resolveVideo("https://www.bilibili.com/video/BV1xx411c7mD?p=-1"),
    { status: 400 },
  );
});
