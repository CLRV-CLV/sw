import { randomUUID } from "node:crypto";
const fail = (status, message) => Object.assign(new Error(message), { status });
const types = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const max = 30 * 1024 * 1024;
export function createUploads(db, profiles, {premium} = {}) {
  // Public, deliberately published raster images only. Private chat uses its own member-only storage.
  db.exec(
    `CREATE TABLE IF NOT EXISTS image_uploads(id TEXT PRIMARY KEY,userId TEXT,data TEXT,bytes BLOB)`,
  );
  const read = (id) => {
    const row = db.prepare("SELECT * FROM image_uploads WHERE id=?").get(id);
    return row && { ...row, meta: JSON.parse(row.data) };
  };
  const media = (r) => ({
    id: r.id,
    ...r.meta,
    url: `/media/uploads/${r.id}.${types[r.meta.mime]}`,
  });
  function owned(id, user) {
    const r = read(id);
    if (!r || r.userId !== user.id) throw fail(404, "图片不存在");
    return r;
  }
  function resolveImages(ids, user) {
    if (
      !Array.isArray(ids) ||
      ids.length > 40 ||
      ids.some((id) => typeof id !== "string")
    )
      throw fail(400, "图片列表无效");
    return ids.map((id) => {
      const r = owned(id, user);
      if (!r.meta.complete) throw fail(400, "图片尚未上传完成");
      return media(r);
    });
  }
  async function handler({ path, req, url, auth, body, reply, res }) {
    const publicImage = path.match(
      /^\/media\/uploads\/([\w-]+)\.(png|jpg|gif|webp)$/,
    );
    if (publicImage && ["GET", "HEAD"].includes(req.method)) {
      const r = read(publicImage[1]);
      if (!r?.meta.complete || types[r.meta.mime] !== publicImage[2])
        throw fail(404, "图片不存在");
      res.writeHead(200, {
        "content-type": r.meta.mime,
        "content-length": r.bytes.length,
        "x-content-type-options": "nosniff",
        "cache-control": "public,max-age=31536000,immutable",
        "content-security-policy": "default-src 'none'; sandbox",
      });
      res.end(req.method === "HEAD" ? undefined : r.bytes);
      return true;
    }
    if (path === "/v1/uploads/sign" && req.method === "POST") {
      const u = auth(),
        b = await body(req);
      if (
        !types[b.mimeType] ||
        !Number.isSafeInteger(b.size) ||
        b.size < 1 ||
        b.size > max
      )
        throw fail(400, "仅支持PNG/JPEG/WebP/GIF图片，最大30MB");
      // Expired reservations have no bytes and can safely be removed.
      db.prepare(
        "DELETE FROM image_uploads WHERE bytes IS NULL AND json_extract(data,'$.expires')<?",
      ).run(Date.now());
      const rows = db
        .prepare("SELECT data FROM image_uploads WHERE userId=?")
        .all(u.id)
        .map((r) => JSON.parse(r.data));
      if (
        rows.reduce((a, r) => a + r.size, 0) + b.size > 200 * 1024 * 1024 ||
        rows.filter((r) => !r.complete).length >= 20
      )
        throw fail(429, "图片存储配额或待上传数量已达上限");
      const id = randomUUID(),
        meta = {
          name: String(b.filename || "图片").slice(0, 200),
          mime: b.mimeType,
          size: b.size,
          createdAt: new Date().toISOString(),
          expires: Date.now() + 900000,
          complete: false,
        };
      db.prepare("INSERT INTO image_uploads VALUES(?,?,?,NULL)").run(
        id,
        u.id,
        JSON.stringify(meta),
      );
      reply({
        uploadId: id,
        uploadUrl: `/v1/uploads/${id}/content`,
        method: "PUT",
        headers: { "Content-Type": b.mimeType },
      });
      return true;
    }
    const upload = path.match(/^\/v1\/uploads\/([\w-]+)\/(content|complete)$/);
    if (upload) {
      const u = auth(),
        r = owned(upload[1], u);
      if (r.meta.complete) {
        if (upload[2] === "complete" && req.method === "POST") {
          reply(media(r));
          return true;
        }
        throw fail(409, "已完成图片不能覆盖");
      }
      if (r.meta.expires < Date.now()) throw fail(410, "上传凭证已过期");
      if (upload[2] === "content" && req.method === "PUT") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > r.meta.size || size > max)
            throw fail(413, "图片超过声明大小");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const mime = bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            ? "image/jpeg"
            : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
              ? "image/gif"
              : bytes.subarray(0, 4).toString() === "RIFF" &&
                  bytes.subarray(8, 12).toString() === "WEBP"
                ? "image/webp"
                : "";
        if (size !== r.meta.size || mime !== r.meta.mime)
          throw fail(400, "文件内容与图片类型/大小不符，不接受SVG或脚本");
        db.prepare("UPDATE image_uploads SET bytes=? WHERE id=?").run(
          bytes,
          r.id,
        );
        reply({ ok: true });
        return true;
      }
      if (upload[2] === "complete" && req.method === "POST") {
        if (!r.bytes) throw fail(400, "请先上传图片");
        const b = await body(req);
        for (const key of ["width", "height"])
          if (
            b[key] != null &&
            (!Number.isSafeInteger(b[key]) || b[key] < 1 || b[key] > 100000)
          )
            throw fail(400, "图片尺寸无效");
        r.meta = {
          ...r.meta,
          complete: true,
          width: b.width || null,
          height: b.height || null,
        };
        db.prepare("UPDATE image_uploads SET data=? WHERE id=?").run(
          JSON.stringify(r.meta),
          r.id,
        );
        reply(media(r));
        return true;
      }
    }
    if (path === "/v1/me/uploads" && req.method === "GET") {
      const u = auth(),
        offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0),
        limit = Math.min(
          50,
          Math.max(1, Number(url.searchParams.get("limit")) || 24),
        );
      const all = db
        .prepare(
          "SELECT id,userId,data FROM image_uploads WHERE userId=? ORDER BY rowid DESC",
        )
        .all(u.id)
        .map((r) => ({ ...r, meta: JSON.parse(r.data) }))
        .filter((r) => r.meta.complete && !r.meta.hidden);
      reply({
        items: all.slice(offset, offset + limit).map(media),
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      });
      return true;
    }
    const hide = path.match(/^\/v1\/me\/uploads\/([\w-]+)$/);
    if (hide && req.method === "DELETE") {
      const r = owned(hide[1], auth());
      db.prepare("UPDATE image_uploads SET data=? WHERE id=?").run(
        JSON.stringify({ ...r.meta, hidden: true }),
        r.id,
      );
      reply({ deleted: true, inUse: true });
      return true;
    }
    if (path === "/v1/me/avatar" && ["PUT", "DELETE"].includes(req.method)) {
      const u = auth();
      let avatar = null;
      if (req.method === "PUT") {
        const b = await body(req);
        avatar = resolveImages([b.mediaId], u)[0];
      }
      const apply=()=>profiles.set(u.id,{avatarUrl:avatar?.url||''});
      const polychrome=avatar&&premium?premium.purchase(u.id,'avatar',avatar.id,apply):(apply(),profiles.get(u.id).polychrome);
      reply({ avatar, polychrome });
      return true;
    }
    if(path==='/v1/me/card'&&req.method==='PUT'){
      const u=auth(),b=await body(req),image=resolveImages([b.mediaId],u)[0];
      const card={id:'upload-'+image.id,name:'自定义名片',kind:'city',image};
      if(!premium)throw fail(503,'名片上传服务未配置');
      const polychrome=premium.purchase(u.id,'card',image.id,()=>{
        db.prepare('INSERT OR REPLACE INTO custom_cards VALUES(?,?,?)').run(card.id,u.id,JSON.stringify(card));
        db.prepare('INSERT OR REPLACE INTO user_cosmetics VALUES(?,?)').run(u.id,card.id);
      });reply({card,polychrome});return true;
    }
    return false;
  }
  return { handler, resolveImages };
}
