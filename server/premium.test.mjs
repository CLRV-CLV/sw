import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { createProfiles } from "./site-data.mjs";
import { createPremium } from "./premium.mjs";
import { createUploads } from "./uploads.mjs";
import { createAdmin } from "./admin.mjs";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVpQAAAAASUVORK5CYII=",
  "base64",
);
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT);INSERT INTO users VALUES('a','a'),('b','b');CREATE TABLE posts(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE comments(id TEXT PRIMARY KEY,postId TEXT,data TEXT);CREATE TABLE sessions(token TEXT,userId TEXT,expires INTEGER)",
  );
  const profiles = createProfiles(db),
    premium = createPremium(db, profiles, { roll: () => 7 });
  return { db, profiles, premium };
}
test("cosmetic uploads debit 20 polychrome, retry safely, reject insufficient funds and enforce media ownership", async () => {
  const { db, profiles, premium } = fixture();
  const uploads = createUploads(db, profiles, { premium });
  const call = async (path, method = "GET", data = {}, uid = "a", bytes) => {
    let result;
    await uploads.handler({
      path,
      url: new URL(path, "http://test"),
      req: Object.assign(Readable.from(bytes ? [bytes] : []), { method }),
      auth: () => ({ id: uid }),
      body: async () => data,
      reply: (r) => (result = r),
    });
    return result;
  };
  try {
    const signed = await call("/v1/uploads/sign", "POST", {
      filename: "image.png",
      size: png.length,
      mimeType: "image/png",
    });
    await call(signed.uploadUrl, "PUT", {}, "a", png);
    await call("/v1/uploads/" + signed.uploadId + "/complete", "POST");
    const body = { mediaId: signed.uploadId };
    await assert.rejects(call("/v1/me/avatar", "PUT", body), { status: 409 });
    assert.equal(profiles.get("a").avatarUrl, "");
    profiles.set("a", { polychrome: 40 });
    assert.equal((await call("/v1/me/avatar", "PUT", body)).polychrome, 20);
    assert.equal((await call("/v1/me/avatar", "PUT", body)).polychrome, 20);
    await assert.rejects(call("/v1/me/card", "PUT", body, "b"), {
      status: 404,
    });
    const card = await call("/v1/me/card", "PUT", body);
    assert.equal(card.polychrome, 0);
    assert.match(card.card.image.url, /^\/media\/uploads\//);
    assert.equal((await call("/v1/me/card", "PUT", body)).polychrome, 0);
    assert.equal(
      db.prepare("SELECT count(*) n FROM polychrome_logs").get().n,
      2,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM custom_cards").get().n, 1);
  } finally {
    db.close();
  }
});
test("only admin review grants 0-10 per three distinct posts, and repeat review cannot farm rewards", async () => {
  const { db, profiles, premium } = fixture();
  const admin = createAdmin(db, {
    env: { ADMIN_USERNAMES: "a" },
    onPostApproved: premium.approvePost,
  });
  const approve = async (id, uid = "a") =>
    admin.handler({
      path: "/v1/admin/posts/" + id,
      req: { method: "PATCH" },
      url: new URL("http://test"),
      auth: () => ({ id: uid, username: uid }),
      body: async () => ({ status: "published" }),
      reply: () => {},
    });
  try {
    for (let i = 0; i < 6; i++) {
      const id = "p" + i;
      db.prepare("INSERT INTO posts VALUES(?,?)").run(
        id,
        JSON.stringify({
          id,
          title: id,
          body: "test",
          authorId: "b",
          status: "published",
        }),
      );
    }
    assert.equal(profiles.get("b").polychrome, 0);
    await assert.rejects(approve("p0", "b"), { status: 403 });
    await approve("p0");
    await approve("p1");
    assert.equal(profiles.get("b").polychrome, 0);
    await approve("p2");
    assert.equal(profiles.get("b").polychrome, 7);
    await approve("p2");
    assert.equal(profiles.get("b").polychrome, 7);
    for (let i = 3; i < 6; i++) await approve("p" + i);
    assert.equal(profiles.get("b").polychrome, 14);
    assert.equal(
      db.prepare("SELECT count(*) n FROM premium_rewards").get().n,
      2,
    );
  } finally {
    db.close();
  }
});
