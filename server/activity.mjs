import { randomUUID } from "node:crypto";
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createActivity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_tasks(id TEXT PRIMARY KEY,userId TEXT,data TEXT);
 CREATE TABLE IF NOT EXISTS personal_notifications(id TEXT PRIMARY KEY,userId TEXT,data TEXT);
 CREATE TABLE IF NOT EXISTS notification_keys(key TEXT PRIMARY KEY);`);
  const parse = (r) => JSON.parse(r.data);
  function notify(userId, kind, text, href, key) {
    if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(userId)) return;
    const k = key || randomUUID();
    db.exec("SAVEPOINT notification");
    try {
      if (
        db.prepare("INSERT OR IGNORE INTO notification_keys VALUES(?)").run(k)
          .changes
      ) {
        db.prepare("INSERT INTO personal_notifications VALUES(?,?,?)").run(
          randomUUID(),
          userId,
          JSON.stringify({
            kind,
            text,
            href,
            read: false,
            createdAt: new Date().toISOString(),
          }),
        );
      }
      db.exec("RELEASE notification");
    } catch (e) {
      db.exec("ROLLBACK TO notification");
      db.exec("RELEASE notification");
      throw e;
    }
  }
  async function handler({ path, req, auth, body, reply, url }) {
    if (path === "/v1/me/notifications" && req.method === "GET") {
      const u = auth(),
        rows = db
          .prepare(
            "SELECT * FROM personal_notifications WHERE userId=? ORDER BY rowid DESC LIMIT 100",
          )
          .all(u.id);
      reply({
        items: rows.map((r) => ({ id: r.id, ...parse(r) })),
        unread: db
          .prepare(
            "SELECT count(*) n FROM personal_notifications WHERE userId=? AND json_extract(data,'$.read')=0",
          )
          .get(u.id).n,
      });
      return true;
    }
    if (path === "/v1/me/notifications/read" && req.method === "POST") {
      const u = auth(),
        b = await body(req);
      if (
        b.all !== true &&
        (!Array.isArray(b.ids) ||
          b.ids.length > 100 ||
          b.ids.some((id) => typeof id !== "string"))
      )
        throw fail(400, "无效通知列表");
      for (const r of db
        .prepare("SELECT * FROM personal_notifications WHERE userId=?")
        .all(u.id)) {
        if (b.all === true || b.ids.includes(r.id))
          db.prepare(
            "UPDATE personal_notifications SET data=? WHERE id=? AND userId=?",
          ).run(JSON.stringify({ ...parse(r), read: true }), r.id, u.id);
      }
      reply({ ok: true });
      return true;
    }
    if (path === "/v1/me/tasks" && req.method === "GET") {
      const u = auth();
      reply({
        items: db
          .prepare(
            "SELECT * FROM personal_tasks WHERE userId=? ORDER BY rowid DESC LIMIT 500",
          )
          .all(u.id)
          .map((r) => ({ id: r.id, ...parse(r) })),
      });
      return true;
    }
    const task = path.match(/^\/v1\/me\/tasks(?:\/([\w-]+))?$/);
    if (task && ["POST", "PATCH", "DELETE"].includes(req.method)) {
      const u = auth(),
        id = task[1];
      let old = { done: false, dueAt: null };
      if (id) {
        const r = db
          .prepare("SELECT data FROM personal_tasks WHERE id=? AND userId=?")
          .get(id, u.id);
        if (!r) throw fail(404, "日程不存在");
        old = parse(r);
      } else if (req.method !== "POST") throw fail(405, "无效日程操作");
      if (req.method === "DELETE") {
        db.prepare("DELETE FROM personal_tasks WHERE id=? AND userId=?").run(
          id,
          u.id,
        );
        reply({ ok: true });
        return true;
      }
      const b = await body(req);
      if (
        Object.keys(b).some(
          (k) => !["title", "notes", "dueAt", "done"].includes(k),
        ) ||
        ("title" in b &&
          (typeof b.title !== "string" ||
            !b.title.trim() ||
            b.title.length > 200)) ||
        ("notes" in b &&
          (typeof b.notes !== "string" || b.notes.length > 4000)) ||
        ("done" in b && typeof b.done !== "boolean") ||
        ("dueAt" in b &&
          b.dueAt !== null &&
          (typeof b.dueAt !== "string" ||
            !Number.isFinite(Date.parse(b.dueAt))))
      )
        throw fail(400, "无效日程字段");
      const result = { ...old, ...b, updatedAt: new Date().toISOString() };
      if (!result.title) throw fail(400, "请输入日程标题");
      if (
        !id &&
        db
          .prepare("SELECT count(*) n FROM personal_tasks WHERE userId=?")
          .get(u.id).n >= 500
      )
        throw fail(429, "最多保存500项日程");
      const rid = id || randomUUID();
      db.prepare("INSERT OR REPLACE INTO personal_tasks VALUES(?,?,?)").run(
        rid,
        u.id,
        JSON.stringify(result),
      );
      reply({ id: rid, ...result });
      return true;
    }
    return false;
  }
  return { handler, notify };
}
