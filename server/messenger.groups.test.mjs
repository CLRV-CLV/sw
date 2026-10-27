import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMessenger } from "./messenger.mjs";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT)");
  for (const id of ["a", "b", "c", "outsider"])
    db.prepare("INSERT INTO users VALUES(?,?)").run(id, id);
  const events = [];
  const service = createMessenger(db, {
    publicUser: (u) => ({ ...u, name: u.username }),
    banned: () => false,
    send: (uid, t, d) => events.push({ uid, t, d }),
  });
  async function call(user, path, method = "GET", data = {}) {
    let result;
    await service.handler({
      path: path.split("?")[0],
      url: new URL(path, "http://test"),
      req: { method },
      auth: () => ({ id: user }),
      body: async () => data,
      reply: (r) => (result = r),
    });
    return result;
  }
  return { db, call, events, service };
}
test("groups: owner management, join history boundary, member isolation, search, removal, transfer, dissolution", async () => {
  const { db, call, events, service } = fixture();
  try {
    await assert.rejects(
      call("a", "/v1/dm/groups", "POST", { title: "bad", userIds: [] }),
      { status: 400 },
    );
    const group = await call("a", "/v1/dm/groups", "POST", {
      title: "绳匠小队",
      userIds: ["b", "b"],
    });
    const cid = group.id,
      path = `/v1/dm/groups/${cid}`;
    assert.equal(group.kind, "group");
    assert.equal(group.memberCount, 2);
    const post = (u, text, id, replyToId) =>
      call(u, `/v1/dm/conversations/${cid}/messages`, "POST", {
        content: text,
        clientId: id,
        replyToId,
      });
    const first = await post("a", "before invitation", "first");
    assert.equal(
      (await call("b", "/v1/inbox")).items[0].conversationKind,
      "group",
    );
    await assert.rejects(call("outsider", path), { status: 403 });
    await assert.rejects(call("b", path, "PATCH", { title: "hacked" }), {
      status: 403,
    });
    await assert.rejects(
      call("b", path + "/members", "POST", { userId: "outsider" }),
      { status: 403 },
    );
    await call("a", path + "/members", "POST", { userId: "c" });
    assert.equal(
      (await call("c", `/v1/inbox/dm-${cid}/items`)).items.length,
      0,
    );
    assert.equal(
      (await call("c", `/v1/dm/conversations/${cid}/search?q=invitation`)).items
        .length,
      0,
    );
    await assert.rejects(post("c", "quote hidden", "hidden-quote", first.id), {
      status: 400,
    });
    const second = await post("b", "AFTER invitation", "second");
    assert.equal(
      (await call("c", `/v1/inbox/dm-${cid}/items`)).items.length,
      1,
    );
    assert.equal(
      (await call("c", `/v1/dm/conversations/${cid}/search?q=after`)).items[0]
        .id,
      second.id,
    );
    assert.equal(
      (await call("b", `/v1/dm/conversations/${cid}/search?q=invitation`)).items
        .length,
      2,
    );
    await assert.rejects(
      call("outsider", `/v1/dm/conversations/${cid}/search?q=after`),
      { status: 403 },
    );
    await call("b", `/v1/dm/messages/${second.id}`, "DELETE");
    assert.equal(
      (await call("c", `/v1/dm/conversations/${cid}/search?q=after`)).items
        .length,
      0,
    );
    await call("a", path + "/members/c", "DELETE");
    events.length = 0;
    await post("a", "members only", "third");
    assert.ok(events.every((e) => e.uid === "a" || e.uid === "b"));
    await assert.rejects(call("c", `/v1/inbox/dm-${cid}/items`), {
      status: 403,
    });
    assert.throws(() => service.typing(cid, "c"), { status: 403 });
    await assert.rejects(call("a", path + "/members/a", "DELETE"), {
      status: 409,
    });
    await call("a", path, "PATCH", { title: "新名称", ownerId: "b" });
    assert.equal((await call("b", path)).title, "新名称");
    await assert.rejects(call("a", path, "DELETE"), { status: 403 });
    await call("a", path + "/members/a", "DELETE");
    await call("b", path, "DELETE");
    assert.equal(db.prepare("SELECT count(*) n FROM dm_messages").get().n, 0);
    assert.equal((await call("b", "/v1/inbox")).items.length, 0);
  } finally {
    db.close();
  }
});
test("friends: requests are recipient-bound, acceptance is mutual, remark/group private, blacklist blocks direct messages and typing", async () => {
  const { db, call, events, service } = fixture();
  try {
    await call("a", "/v1/dm/friend-requests", "POST", { userId: "b" });
    const r = (await call("b", "/v1/dm/friend-requests")).items[0];
    await assert.rejects(
      call("outsider", `/v1/dm/friend-requests/${r.id}/accept`, "POST"),
      { status: 404 },
    );
    await call("b", `/v1/dm/friend-requests/${r.id}/accept`, "POST");
    assert.equal((await call("a", "/v1/dm/friends")).items[0].accepted, 1);
    assert.equal((await call("b", "/v1/dm/friends")).items[0].accepted, 1);
    await call("a", "/v1/dm/friends/b", "PATCH", {
      remark: "我的备注",
      groupName: "队友",
    });
    assert.equal(
      (await call("a", "/v1/dm/friends")).items[0].remark,
      "我的备注",
    );
    assert.equal((await call("b", "/v1/dm/friends")).items[0].remark, "");
    await assert.rejects(
      call("a", "/v1/dm/friends/b", "PATCH", { accepted: true }),
      { status: 400 },
    );
    const c = await call("a", "/v1/dm/direct", "POST", { userId: "b" });
    await call("b", "/v1/dm/friends/a", "PATCH", { blocked: true });
    await assert.rejects(call("a", "/v1/dm/direct", "POST", { userId: "b" }), {
      status: 400,
    });
    await assert.rejects(
      call("a", `/v1/dm/conversations/${c.id}/messages`, "POST", {
        content: "blocked",
        clientId: "blocked",
      }),
      { status: 403 },
    );
    events.length = 0;
    service.typing(c.id, "a");
    assert.equal(events.length, 0);
    await call("b", "/v1/dm/friends/a", "PATCH", { blocked: false });
    await call("a", "/v1/dm/friends/b", "DELETE");
    assert.equal((await call("a", "/v1/dm/friends")).items.length, 0);
    assert.equal((await call("b", "/v1/dm/friends")).items.length, 0);
    await call("a", "/v1/dm/friend-requests", "POST", { userId: "b" });
    const retry = (await call("b", "/v1/dm/friend-requests")).items[0];
    await call("b", `/v1/dm/friend-requests/${retry.id}/reject`, "POST");
    assert.equal((await call("b", "/v1/dm/friend-requests")).items.length, 0);
    await call("b", "/v1/dm/friends/a", "PATCH", { blocked: true });
    await assert.rejects(
      call("a", "/v1/dm/friend-requests", "POST", { userId: "b" }),
      { status: 403 },
    );
  } finally {
    db.close();
  }
});
test("migration preserves an existing direct conversation and message", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT);INSERT INTO users VALUES('a','a'),('b','b');CREATE TABLE dm_members(conversationId TEXT,userId TEXT,readSeq INTEGER DEFAULT 0,muted INTEGER DEFAULT 0,pinned INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,PRIMARY KEY(conversationId,userId));CREATE TABLE dm_conversations(id TEXT PRIMARY KEY,pair TEXT UNIQUE,createdAt TEXT);INSERT INTO dm_conversations VALUES('old','a:b','2026-01-01');INSERT INTO dm_members(conversationId,userId) VALUES('old','a'),('old','b');`,
    );
    const service = createMessenger(db, {
      publicUser: (u) => ({ ...u, name: u.username }),
      banned: () => false,
      send: () => {},
    });
    let result;
    await service.handler({
      path: "/v1/inbox",
      req: { method: "GET" },
      url: new URL("http://test/v1/inbox"),
      auth: () => ({ id: "a" }),
      reply: (r) => (result = r),
    });
    assert.equal(result.items[0].conversationId, "old");
    assert.equal(result.items[0].conversationKind, "direct");
    assert.equal(
      db.prepare("SELECT joinedSeq FROM dm_members LIMIT 1").get().joinedSeq,
      0,
    );
  } finally {
    db.close();
  }
});
test("attachments are member-only, bounded, canonical, recall deletes bytes; late join cannot download old files", async () => {
  const { db, call } = fixture();
  try {
    const g = await call("a", "/v1/dm/groups", "POST", {
      title: "Files",
      userIds: ["b"],
    });
    const cid = g.id;
    const data = Buffer.from("<script>alert(1)</script>").toString("base64");
    const service = createMessenger(db, {
      publicUser: (u) => ({ ...u, name: u.username }),
      banned: () => false,
      send: () => {},
    });
    async function download(uid, id) {
      let result;
      await service.handler({
        path: `/v1/dm/attachments/${id}`,
        req: { method: "GET" },
        url: new URL("http://test"),
        auth: () => ({ id: uid }),
        fileReply: (bytes, a) => (result = { bytes, a }),
      });
      return result;
    }
    const path = `/v1/dm/conversations/${cid}/messages`;
    const msg = await call("a", path, "POST", {
      content: "document.html",
      clientId: "file-1",
      attachment: { name: "document.html", mime: "text/html", data },
    });
    assert.equal(msg.attachment.mime, "application/octet-stream");
    assert.equal(msg.kind, "file");
    assert.equal(
      Buffer.from((await download("b", msg.id)).bytes).toString(),
      "<script>alert(1)</script>",
    );
    await assert.rejects(download("outsider", msg.id), { status: 403 });
    await call("a", `/v1/dm/groups/${cid}/members`, "POST", { userId: "c" });
    await assert.rejects(download("c", msg.id), { status: 404 });
    await assert.rejects(
      call("a", path, "POST", {
        content: "bad",
        clientId: "bad",
        attachment: { name: "x.svg", mime: "image/svg+xml", data },
      }),
      { status: 400 },
    );
    await assert.rejects(
      call("a", path, "POST", {
        content: "bad",
        clientId: "bad2",
        attachment: { name: "x.png", mime: "image/png", data },
      }),
      { status: 400 },
    );
    await assert.rejects(
      call("a", path, "POST", {
        content: "bad",
        clientId: "bad3",
        attachment: { name: "x.txt", mime: "text/plain", data: "a===" },
      }),
      { status: 400 },
    );
    // A realistic large file must not overflow the regex stack, and quota is in decoded bytes.
    const large = await call("a", path, "POST", {
      content: "large.bin",
      clientId: "large",
      attachment: {
        name: "large.bin",
        mime: "application/octet-stream",
        data: Buffer.alloc(1048576).toString("base64"),
      },
    });
    assert.equal(large.attachment.size, 1048576);
    await call("a", `/v1/dm/messages/${msg.id}`, "DELETE");
    assert.equal(
      db.prepare("SELECT 1 FROM dm_attachments WHERE messageId=?").get(msg.id),
      undefined,
    );
    await assert.rejects(download("b", msg.id), { status: 404 });
  } finally {
    db.close();
  }
});
test("announcement channels enforce owner-only publishing; message pins are shared, bounded by membership and removed on recall", async () => {
  const { db, call } = fixture();
  try {
    const g = await call("a", "/v1/dm/groups", "POST", {
      title: "公告",
      mode: "channel",
      userIds: ["b"],
    });
    const cid = g.id;
    assert.equal(g.kind, "channel");
    assert.equal(
      (await call("b", "/v1/inbox")).items[0].conversationKind,
      "channel",
    );
    await assert.rejects(
      call("b", `/v1/dm/conversations/${cid}/messages`, "POST", {
        content: "unauthorized",
        clientId: "unauthorized",
      }),
      { status: 403 },
    );
    const msg = await call(
      "a",
      `/v1/dm/conversations/${cid}/messages`,
      "POST",
      { content: "announcement", clientId: "owner-announcement" },
    );
    await assert.rejects(call("b", `/v1/dm/messages/${msg.id}/pin`, "PUT"), {
      status: 403,
    });
    await call("a", `/v1/dm/messages/${msg.id}/pin`, "PUT");
    assert.equal(
      (await call("b", `/v1/dm/conversations/${cid}/pins`)).items[0].id,
      msg.id,
    );
    await assert.rejects(call("outsider", `/v1/dm/conversations/${cid}/pins`), {
      status: 403,
    });
    await call("a", `/v1/dm/groups/${cid}/members`, "POST", { userId: "c" });
    assert.equal(
      (await call("c", `/v1/dm/conversations/${cid}/pins`)).items.length,
      0,
    );
    await call("a", `/v1/dm/messages/${msg.id}`, "DELETE");
    assert.equal(
      (await call("b", `/v1/dm/conversations/${cid}/pins`)).items.length,
      0,
    );
    await call("a", `/v1/dm/groups/${cid}`, "PATCH", { ownerId: "b" });
    await assert.rejects(
      call("a", `/v1/dm/conversations/${cid}/messages`, "POST", {
        content: "old owner",
        clientId: "old-owner",
      }),
      { status: 403 },
    );
    await call("b", `/v1/dm/conversations/${cid}/messages`, "POST", {
      content: "new owner",
      clientId: "new-owner",
    });
  } finally {
    db.close();
  }
});
