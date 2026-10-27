import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { createUploads } from "./uploads.mjs";
import { createProfiles } from "./site-data.mjs";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVpQAAAAASUVORK5CYII=",
  "base64",
);
test("public raster uploads: auth, owner binding, bounded signature checks, complete, avatar, gallery and restart", async () => {
  const db = new DatabaseSync(":memory:"),
    profiles = createProfiles(db);
  let uploads = createUploads(db, profiles);
  async function call(path, method = "GET", data = {}, uid = "alice", bytes) {
    let result;
    await uploads.handler({
      path,
      url: new URL(path, "http://test"),
      req: Object.assign(Readable.from(bytes ? [bytes] : []), { method }),
      auth: () => {
        if (!uid) throw Object.assign(Error("login"), { status: 401 });
        return { id: uid };
      },
      body: async () => data,
      reply: (r) => {
        result = r;
      },
      res: {
        writeHead(status, headers) {
          result = { status, headers };
        },
        end(bytes) {
          result.bytes = bytes;
        },
      },
    });
    return result;
  }
  try {
    const payload = {
      filename: "a.png",
      size: png.length,
      mimeType: "image/png",
    };
    await assert.rejects(call("/v1/uploads/sign", "POST", payload, null), {
      status: 401,
    });
    await assert.rejects(
      call("/v1/uploads/sign", "POST", {
        ...payload,
        mimeType: "image/svg+xml",
      }),
      { status: 400 },
    );
    const signed = await call("/v1/uploads/sign", "POST", payload),
      id = signed.uploadId;
    await assert.rejects(call(signed.uploadUrl, "PUT", {}, "bob", png), {
      status: 404,
    });
    await assert.rejects(call(`/v1/uploads/${id}/complete`, "POST"), {
      status: 400,
    });
    await call(signed.uploadUrl, "PUT", {}, "alice", png);
    const image = await call(`/v1/uploads/${id}/complete`, "POST", {
      width: 1,
      height: 1,
    });
    assert.equal(image.mime, "image/png");
    assert.deepEqual(
      uploads.resolveImages([id], { id: "alice" }).map((r) => r.url),
      [image.url],
    );
    await assert.rejects(
      async () => uploads.resolveImages([id], { id: "bob" }),
      { status: 404 },
    );
    const pub = await call(image.url, "GET", {}, null);
    assert.equal(pub.headers["content-type"], "image/png");
    assert.deepEqual(Buffer.from(pub.bytes), png);
    await assert.rejects(call(signed.uploadUrl, "PUT", {}, "alice", png), {
      status: 409,
    });
    await call("/v1/me/avatar", "PUT", { mediaId: id });
    assert.equal(profiles.get("alice").avatarUrl, image.url);
    assert.equal((await call("/v1/me/uploads")).items.length, 1);
    await call(`/v1/me/uploads/${id}`, "DELETE");
    assert.equal((await call("/v1/me/uploads")).items.length, 0);
    uploads = createUploads(db, profiles);
    assert.equal((await call(image.url, "GET", {}, null)).status, 200);
    const evil = await call("/v1/uploads/sign", "POST", {
      ...payload,
      size: 10,
    });
    await assert.rejects(
      call(evil.uploadUrl, "PUT", {}, "alice", Buffer.from("<script/>!")),
      { status: 400 },
    );
    await call("/v1/me/avatar", "DELETE");
    assert.equal(profiles.get("alice").avatarUrl, "");
  } finally {
    db.close();
  }
});
