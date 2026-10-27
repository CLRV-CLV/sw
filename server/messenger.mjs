import { randomUUID } from "node:crypto";
export function createMessenger(db, { publicUser, send, banned }) {
  db.exec(`CREATE TABLE IF NOT EXISTS dm_conversations(id TEXT PRIMARY KEY,pair TEXT UNIQUE,createdAt TEXT);
    CREATE TABLE IF NOT EXISTS dm_members(conversationId TEXT,userId TEXT,readSeq INTEGER DEFAULT 0,muted INTEGER DEFAULT 0,pinned INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,PRIMARY KEY(conversationId,userId));
    CREATE TABLE IF NOT EXISTS dm_messages(id TEXT PRIMARY KEY,conversationId TEXT,senderId TEXT,clientId TEXT,data TEXT,UNIQUE(senderId,clientId));
    CREATE TABLE IF NOT EXISTS dm_pins(conversationId TEXT,messageId TEXT PRIMARY KEY,actorId TEXT,createdAt TEXT);
    CREATE TABLE IF NOT EXISTS dm_attachments(messageId TEXT PRIMARY KEY,ownerId TEXT,bytes BLOB);
    CREATE TABLE IF NOT EXISTS dm_groups(conversationId TEXT PRIMARY KEY,title TEXT NOT NULL,ownerId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dm_relationships(ownerId TEXT,peerId TEXT,accepted INTEGER DEFAULT 0,remark TEXT DEFAULT '',groupName TEXT DEFAULT '',blocked INTEGER DEFAULT 0,PRIMARY KEY(ownerId,peerId));
    CREATE TABLE IF NOT EXISTS dm_friend_requests(id TEXT PRIMARY KEY,senderId TEXT,targetId TEXT,status TEXT DEFAULT 'pending',createdAt TEXT,UNIQUE(senderId,targetId));`);
  if (
    !db
      .prepare("PRAGMA table_info(dm_members)")
      .all()
      .some((c) => c.name === "joinedSeq")
  )
    db.exec("ALTER TABLE dm_members ADD COLUMN joinedSeq INTEGER DEFAULT 0");
  if (
    !db
      .prepare("PRAGMA table_info(dm_groups)")
      .all()
      .some((c) => c.name === "mode")
  )
    db.exec("ALTER TABLE dm_groups ADD COLUMN mode TEXT DEFAULT 'group'");
  db.exec(`CREATE INDEX IF NOT EXISTS dm_messages_conversation ON dm_messages(conversationId);
    CREATE INDEX IF NOT EXISTS dm_members_user ON dm_members(userId);
    CREATE INDEX IF NOT EXISTS dm_requests_target ON dm_friend_requests(targetId,status);
    CREATE INDEX IF NOT EXISTS dm_groups_owner ON dm_groups(ownerId);`);
  const fail = (status, msg) => Object.assign(new Error(msg), { status }),
    now = () => new Date().toISOString();
  function member(cid, uid) {
    const r = db
      .prepare("SELECT * FROM dm_members WHERE conversationId=? AND userId=?")
      .get(cid, uid);
    if (!r) throw fail(403, "无权访问该会话");
    return r;
  }
  function messageView(raw) {
    const m = typeof raw === "string" ? JSON.parse(raw) : { ...raw };
    if (m.replyTo) {
      const row = db
        .prepare("SELECT data FROM dm_messages WHERE id=? AND conversationId=?")
        .get(m.replyTo.id, m.conversationId);
      const ref = row && JSON.parse(row.data);
      m.replyTo = {
        ...m.replyTo,
        content: ref?.withdrawnAt ? "" : ref?.content || "",
        withdrawn: !ref || !!ref.withdrawnAt,
      };
    }
    m.sender = publicUser(
      db.prepare("SELECT id,username FROM users WHERE id=?").get(m.senderId),
    );
    return m;
  }
  const blocked = (a, b) =>
    !!db
      .prepare(
        "SELECT 1 FROM dm_relationships WHERE ((ownerId=? AND peerId=?) OR (ownerId=? AND peerId=?)) AND blocked=1",
      )
      .get(a, b, b, a);
  function targetUser(id) {
    const u = db.prepare("SELECT id,username FROM users WHERE id=?").get(id);
    if (!u || banned(u)) throw fail(400, "账号不可用");
    return u;
  }
  function text(value, max, label) {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw fail(400, `无效${label}`);
    return value.trim();
  }
  const group = (cid) =>
    db.prepare("SELECT * FROM dm_groups WHERE conversationId=?").get(cid);
  function owned(cid, uid) {
    const g = group(cid);
    if (!g || g.ownerId !== uid) throw fail(403, "仅群主可管理");
    return g;
  }
  const peers = (cid) =>
    db
      .prepare("SELECT userId FROM dm_members WHERE conversationId=?")
      .all(cid)
      .map((r) => r.userId);
  function summary(cid, uid) {
    const m = member(cid, uid),
      g = group(cid),
      peerId = peers(cid).find((id) => id !== uid),
      u = g
        ? null
        : db.prepare("SELECT id,username FROM users WHERE id=?").get(peerId),
      last = db
        .prepare(
          "SELECT data FROM dm_messages WHERE conversationId=? AND rowid>? ORDER BY rowid DESC LIMIT 1",
        )
        .get(cid, m.joinedSeq),
      msg = last ? JSON.parse(last.data) : null;
    return {
      id: cid,
      kind: g ? g.mode : "direct",
      peer: g
        ? { id: cid, name: g.title, avatarUrl: "", level: 0 }
        : publicUser(u),
      ...(g
        ? { title: g.title, ownerId: g.ownerId, memberCount: peers(cid).length }
        : {}),
      muted: !!m.muted,
      pinned: !!m.pinned,
      activityAt:
        msg?.createdAt ||
        db.prepare("SELECT createdAt FROM dm_conversations WHERE id=?").get(cid)
          .createdAt,
      lastMessage: msg
        ? {
            id: msg.id,
            createdAt: msg.createdAt,
            preview: msg.withdrawnAt ? "消息已撤回" : msg.content,
            senderId: msg.senderId,
          }
        : null,
      unreadCount: db
        .prepare(
          "SELECT count(*) n FROM dm_messages WHERE conversationId=? AND senderId!=? AND rowid>?",
        )
        .get(cid, uid, Math.max(m.readSeq, m.joinedSeq)).n,
    };
  }

  function notify(cid, type, message) {
    for (const uid of peers(cid)) {
      send(uid, type, { conversationId: cid, messageId: message?.id, message });
      send(uid, "dm.conversation.updated", {
        conversationId: cid,
        ...summary(cid, uid),
      });
    }
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const rate = new Map();
  function limit(uid) {
    const time = Date.now();
    for (const [id, r] of rate) if (time - r.at >= 60000) rate.delete(id);
    const r = rate.get(uid) || { at: time, count: 0 };
    if (++r.count > 120) throw fail(429, "操作太频繁，请稍后重试");
    rate.set(uid, r);
  }
  const handler = async ({ path, req, url, auth, body, reply, fileReply }) => {
    if (!path.startsWith("/v1/dm/") && !path.startsWith("/v1/inbox"))
      return false;
    const user = auth(),
      method = req.method;
    if (!["GET", "HEAD"].includes(method)) limit(user.id);
    const download = path.match(/^\/v1\/dm\/attachments\/([^/]+)$/);
    if (download && method === "GET") {
      const id = decodeURIComponent(download[1]),
        row = db
          .prepare("SELECT rowid seq,* FROM dm_messages WHERE id=?")
          .get(id);
      if (!row) throw fail(404, "文件不存在");
      const m = member(row.conversationId, user.id),
        msg = JSON.parse(row.data);
      if (row.seq <= m.joinedSeq || msg.withdrawnAt || !msg.attachment)
        throw fail(404, "文件不可用");
      const file = db
        .prepare("SELECT bytes FROM dm_attachments WHERE messageId=?")
        .get(id);
      if (!file) throw fail(404, "文件不存在");
      fileReply(file.bytes, msg.attachment);
      return true;
    }
    if (path === "/v1/dm/friends" && method === "GET") {
      reply({
        items: db
          .prepare(
            "SELECT * FROM dm_relationships WHERE ownerId=? AND (accepted=1 OR blocked=1)",
          )
          .all(user.id)
          .map((r) => ({
            ...r,
            user: publicUser(
              db
                .prepare("SELECT id,username FROM users WHERE id=?")
                .get(r.peerId),
            ),
          })),
      });
      return true;
    }
    const relationship = path.match(/^\/v1\/dm\/friends\/([^/]+)$/);
    if (relationship) {
      const peerId = decodeURIComponent(relationship[1]);
      if (peerId === user.id) throw fail(400, "不能操作自己");
      targetUser(peerId);
      if (method === "PATCH") {
        const b = await body(req);
        if (
          !Object.keys(b).length ||
          Object.keys(b).some(
            (k) => !["remark", "groupName", "blocked"].includes(k),
          ) ||
          ("blocked" in b && typeof b.blocked !== "boolean") ||
          ["remark", "groupName"].some(
            (k) => k in b && (typeof b[k] !== "string" || b[k].length > 40),
          )
        )
          throw fail(400, "无效好友设置");
        transaction(() => {
          db.prepare(
            "INSERT OR IGNORE INTO dm_relationships(ownerId,peerId) VALUES(?,?)",
          ).run(user.id, peerId);
          for (const [k, v] of Object.entries(b))
            db.prepare(
              `UPDATE dm_relationships SET ${k}=? WHERE ownerId=? AND peerId=?`,
            ).run(k === "blocked" ? Number(v) : v, user.id, peerId);
        });
        reply({ ok: true });
        return true;
      }
      if (method === "DELETE") {
        db.prepare(
          "UPDATE dm_relationships SET accepted=0 WHERE (ownerId=? AND peerId=?) OR (ownerId=? AND peerId=?)",
        ).run(user.id, peerId, peerId, user.id);
        reply({ ok: true });
        return true;
      }
    }
    if (path === "/v1/dm/friend-requests") {
      if (method === "GET") {
        reply({
          items: db
            .prepare(
              "SELECT * FROM dm_friend_requests WHERE targetId=? AND status='pending' ORDER BY createdAt DESC",
            )
            .all(user.id)
            .map((r) => ({
              ...r,
              user: publicUser(
                db
                  .prepare("SELECT id,username FROM users WHERE id=?")
                  .get(r.senderId),
              ),
            })),
        });
        return true;
      }
      if (method === "POST") {
        const b = await body(req),
          target = targetUser(String(b.userId || ""));
        if (target.id === user.id || blocked(user.id, target.id))
          throw fail(403, "不能向此账号申请");
        if (
          db
            .prepare(
              "SELECT 1 FROM dm_relationships WHERE ownerId=? AND peerId=? AND accepted=1",
            )
            .get(user.id, target.id)
        )
          throw fail(409, "已经是好友");
        const id = randomUUID();
        db.prepare(
          "INSERT INTO dm_friend_requests VALUES(?,?,?,'pending',?) ON CONFLICT(senderId,targetId) DO UPDATE SET status='pending',createdAt=excluded.createdAt",
        ).run(id, user.id, target.id, now());
        send(target.id, "dm.friend.requested", {});
        reply({ ok: true }, 201);
        return true;
      }
    }
    const friendRequest = path.match(
      /^\/v1\/dm\/friend-requests\/([^/]+)\/(accept|reject)$/,
    );
    if (friendRequest && method === "POST") {
      const r = db
        .prepare(
          "SELECT * FROM dm_friend_requests WHERE id=? AND targetId=? AND status='pending'",
        )
        .get(decodeURIComponent(friendRequest[1]), user.id);
      if (!r) throw fail(404, "申请不存在或已处理");
      if (friendRequest[2] === "accept" && blocked(user.id, r.senderId))
        throw fail(403, "请先解除黑名单");
      transaction(() => {
        db.prepare("UPDATE dm_friend_requests SET status=? WHERE id=?").run(
          friendRequest[2] === "accept" ? "accepted" : "rejected",
          r.id,
        );
        if (friendRequest[2] === "accept") {
          for (const [a, b] of [
            [user.id, r.senderId],
            [r.senderId, user.id],
          ])
            db.prepare(
              "INSERT INTO dm_relationships(ownerId,peerId,accepted) VALUES(?,?,1) ON CONFLICT(ownerId,peerId) DO UPDATE SET accepted=1",
            ).run(a, b);
          db.prepare(
            "UPDATE dm_friend_requests SET status='accepted' WHERE senderId=? AND targetId=? AND status='pending'",
          ).run(user.id, r.senderId);
        }
      });
      send(user.id, "dm.friends.updated", {});
      send(r.senderId, "dm.friends.updated", {});
      reply({ ok: true });
      return true;
    }
    if (path === "/v1/dm/groups" && method === "POST") {
      const b = await body(req),
        title = text(b.title, 80, "群名称");
      if (b.mode !== undefined && !["group", "channel"].includes(b.mode))
        throw fail(400, "无效群类型");
      if (
        !Array.isArray(b.userIds) ||
        b.userIds.some((id) => typeof id !== "string") ||
        b.userIds.length > 99
      )
        throw fail(400, "群成员最多100人");
      if (
        db
          .prepare("SELECT count(*) n FROM dm_groups WHERE ownerId=?")
          .get(user.id).n >= 50
      )
        throw fail(400, "每个账号最多创建50个群");
      const ids = [...new Set([user.id, ...b.userIds])];
      if (ids.length < 2) throw fail(400, "至少选择一位成员");
      for (const id of ids) {
        targetUser(id);
        if (id !== user.id && blocked(user.id, id))
          throw fail(403, "不能邀请黑名单账号");
      }
      const cid = randomUUID();
      transaction(() => {
        db.prepare(
          "INSERT INTO dm_conversations(id,pair,createdAt) VALUES(?,NULL,?)",
        ).run(cid, now());
        db.prepare(
          "INSERT INTO dm_groups(conversationId,title,ownerId,mode) VALUES(?,?,?,?)",
        ).run(cid, title, user.id, b.mode || "group");
        for (const id of ids)
          db.prepare(
            "INSERT INTO dm_members(conversationId,userId) VALUES(?,?)",
          ).run(cid, id);
      });
      notify(cid, "dm.conversation.created");
      reply(summary(cid, user.id), 201);
      return true;
    }
    const groupRoute = path.match(
      /^\/v1\/dm\/groups\/([^/]+)(?:\/(members)(?:\/([^/]+))?)?$/,
    );
    if (groupRoute) {
      const cid = decodeURIComponent(groupRoute[1]);
      member(cid, user.id);
      const g = group(cid);
      if (!g) throw fail(404, "群不存在");
      if (!groupRoute[2] && method === "GET") {
        reply({
          ...summary(cid, user.id),
          members: peers(cid).map((id) =>
            publicUser(
              db.prepare("SELECT id,username FROM users WHERE id=?").get(id),
            ),
          ),
        });
        return true;
      }
      if (!groupRoute[2] && method === "PATCH") {
        owned(cid, user.id);
        const b = await body(req);
        if (Object.keys(b).some((k) => !["title", "ownerId"].includes(k)))
          throw fail(400, "无效群设置");
        transaction(() => {
          if ("title" in b)
            db.prepare(
              "UPDATE dm_groups SET title=? WHERE conversationId=?",
            ).run(text(b.title, 80, "群名称"), cid);
          if ("ownerId" in b) {
            if (typeof b.ownerId !== "string") throw fail(400, "无效群主");
            member(cid, b.ownerId);
            targetUser(b.ownerId);
            db.prepare(
              "UPDATE dm_groups SET ownerId=? WHERE conversationId=?",
            ).run(b.ownerId, cid);
          }
        });
        notify(cid, "dm.conversation.updated");
        reply(summary(cid, user.id));
        return true;
      }
      if (groupRoute[2] && !groupRoute[3] && method === "POST") {
        owned(cid, user.id);
        const b = await body(req),
          target = targetUser(String(b.userId || ""));
        if (blocked(user.id, target.id)) throw fail(403, "不能邀请黑名单账号");
        if (peers(cid).length >= 100) throw fail(400, "群已满");
        const seq = db
          .prepare(
            "SELECT COALESCE(MAX(rowid),0) seq FROM dm_messages WHERE conversationId=?",
          )
          .get(cid).seq;
        db.prepare(
          "INSERT OR IGNORE INTO dm_members(conversationId,userId,joinedSeq,readSeq) VALUES(?,?,?,?)",
        ).run(cid, target.id, seq, seq);
        notify(cid, "dm.conversation.created");
        reply(summary(cid, user.id));
        return true;
      }
      if (groupRoute[3] && method === "DELETE") {
        const id = decodeURIComponent(groupRoute[3]);
        if (id !== user.id) owned(cid, user.id);
        if (id === g.ownerId) throw fail(409, "群主须先转让群或解散");
        member(cid, id);
        db.prepare(
          "DELETE FROM dm_members WHERE conversationId=? AND userId=?",
        ).run(cid, id);
        send(id, "dm.conversation.left", { conversationId: cid });
        notify(cid, "dm.conversation.updated");
        reply({ ok: true });
        return true;
      }
      if (!groupRoute[2] && method === "DELETE") {
        owned(cid, user.id);
        const ids = peers(cid);
        transaction(() => {
          db.prepare("DELETE FROM dm_pins WHERE conversationId=?").run(cid);
          db.prepare(
            "DELETE FROM dm_attachments WHERE messageId IN (SELECT id FROM dm_messages WHERE conversationId=?)",
          ).run(cid);
          db.prepare("DELETE FROM dm_messages WHERE conversationId=?").run(cid);
          db.prepare("DELETE FROM dm_members WHERE conversationId=?").run(cid);
          db.prepare("DELETE FROM dm_groups WHERE conversationId=?").run(cid);
          db.prepare("DELETE FROM dm_conversations WHERE id=?").run(cid);
        });
        for (const id of ids)
          send(id, "dm.conversation.left", { conversationId: cid });
        reply({ ok: true });
        return true;
      }
    }
    const searchRoute = path.match(
      /^\/v1\/dm\/conversations\/([^/]+)\/search$/,
    );
    if (searchRoute && method === "GET") {
      const cid = decodeURIComponent(searchRoute[1]),
        m = member(cid, user.id),
        q = text(url.searchParams.get("q"), 100, "搜索关键词").toLowerCase(),
        cursor = Math.max(
          0,
          Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER,
        );
      const rows = db
        .prepare(
          "SELECT rowid seq,data FROM dm_messages WHERE conversationId=? AND rowid>? AND rowid<? AND json_extract(data,'$.withdrawnAt') IS NULL AND instr(lower(json_extract(data,'$.content')),?)>0 ORDER BY rowid DESC LIMIT 51",
        )
        .all(cid, m.joinedSeq, cursor, q);
      reply({
        items: rows.slice(0, 50).map((r) => messageView(r.data)),
        nextCursor: rows.length > 50 ? String(rows[49].seq) : null,
      });
      return true;
    }
    if (path === "/v1/dm/contacts" && method === "GET") {
      const q = (url.searchParams.get("q") || "").slice(0, 40).toLowerCase();
      reply({
        items: db
          .prepare(
            "SELECT id,username FROM users WHERE id!=? ORDER BY rowid DESC LIMIT 500",
          )
          .all(user.id)
          .filter(
            (u) =>
              !banned(u) &&
              (!q ||
                u.username.toLowerCase().includes(q) ||
                publicUser(u).name.toLowerCase().includes(q)),
          )
          .slice(0, 50)
          .map(publicUser),
      });
      return true;
    }
    if (path === "/v1/dm/direct" && method === "POST") {
      const b = await body(req),
        target = db
          .prepare("SELECT id,username FROM users WHERE id=?")
          .get(String(b.userId || ""));
      if (
        !target ||
        target.id === user.id ||
        banned(target) ||
        blocked(user.id, target.id)
      )
        throw fail(400, "不能与此账号建立会话");
      const pair = [user.id, target.id].sort().join(":"),
        cid = transaction(() => {
          let r = db
            .prepare("SELECT id FROM dm_conversations WHERE pair=?")
            .get(pair);
          if (!r) {
            r = { id: randomUUID() };
            db.prepare(
              "INSERT INTO dm_conversations(id,pair,createdAt) VALUES(?,?,?)",
            ).run(r.id, pair, now());
            for (const uid of [user.id, target.id])
              db.prepare(
                "INSERT INTO dm_members(conversationId,userId) VALUES(?,?)",
              ).run(r.id, uid);
          }
          db.prepare(
            "UPDATE dm_members SET hidden=0 WHERE conversationId=? AND userId=?",
          ).run(r.id, user.id);
          return r.id;
        });
      reply(summary(cid, user.id));
      return true;
    }
    if (path === "/v1/inbox" && method === "GET") {
      const all = db
        .prepare(
          "SELECT conversationId FROM dm_members WHERE userId=? AND hidden=0",
        )
        .all(user.id)
        .map((r) => summary(r.conversationId, user.id))
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            b.activityAt.localeCompare(a.activityAt),
        );
      const offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0),
        limit = Math.min(
          50,
          Math.max(1, Number(url.searchParams.get("limit")) || 20),
        );
      reply({
        items: all
          .slice(offset, offset + limit)
          .map((c) => ({
            key: `dm-${c.id}`,
            kind: "conversation",
            conversationId: c.id,
            conversationKind: c.kind,
            ownerId: c.ownerId,
            memberCount: c.memberCount,
            peer: c.peer,
            activityAt: c.activityAt,
            preview: c.lastMessage
              ? {
                  at: c.lastMessage.createdAt,
                  fromMe: c.lastMessage.senderId === user.id,
                  kind: "text",
                  text: c.lastMessage.preview,
                }
              : null,
            unreadCount: c.unreadCount,
            muted: c.muted,
            pinned: c.pinned,
          })),
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
        totalUnread: all.reduce((s, c) => s + c.unreadCount, 0),
      });
      return true;
    }
    if (path === "/v1/inbox/read-all" && method === "POST") {
      for (const r of db
        .prepare("SELECT conversationId FROM dm_members WHERE userId=?")
        .all(user.id))
        db.prepare(
          "UPDATE dm_members SET readSeq=(SELECT COALESCE(MAX(rowid),0) FROM dm_messages WHERE conversationId=?) WHERE conversationId=? AND userId=?",
        ).run(r.conversationId, r.conversationId, user.id);
      send(user.id, "inbox.read.all", {});
      reply({ ok: true });
      return true;
    }
    const inbox = path.match(/^\/v1\/inbox\/([^/]+)\/(items|read)$/);
    if (inbox) {
      const key = decodeURIComponent(inbox[1]),
        cid = key.replace(/^dm-/, "");
      const membership = member(cid, user.id);
      if (inbox[2] === "items" && method === "GET") {
        const cursor = Math.max(
            0,
            Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER,
          ),
          limit = 50,
          rows = db
            .prepare(
              "SELECT rowid seq,data FROM dm_messages WHERE conversationId=? AND rowid<? AND rowid>? ORDER BY rowid DESC LIMIT ?",
            )
            .all(cid, cursor, membership.joinedSeq, limit + 1);
        reply({
          items: rows
            .slice(0, limit)
            .map((r) => ({ type: "message", message: messageView(r.data) })),
          nextCursor: rows.length > limit ? String(rows[limit - 1].seq) : null,
        });
        return true;
      }
      if (inbox[2] === "read" && method === "POST") {
        db.prepare(
          "UPDATE dm_members SET readSeq=(SELECT COALESCE(MAX(rowid),0) FROM dm_messages WHERE conversationId=?) WHERE conversationId=? AND userId=?",
        ).run(cid, cid, user.id);
        send(user.id, "inbox.read", { key, lastReadAt: now() });
        reply({ ok: true });
        return true;
      }
    }
    const conv = path.match(
      /^\/v1\/dm\/conversations\/([^/]+)(?:\/(messages|leave))?$/,
    );
    if (conv) {
      const cid = decodeURIComponent(conv[1]);
      member(cid, user.id);
      if (!conv[2] && method === "PATCH") {
        const b = await body(req);
        if (
          Object.keys(b).some((k) => !["muted", "pinned"].includes(k)) ||
          Object.values(b).some((v) => typeof v !== "boolean")
        )
          throw fail(400, "无效会话设置");
        for (const [k, v] of Object.entries(b))
          db.prepare(
            `UPDATE dm_members SET ${k}=? WHERE conversationId=? AND userId=?`,
          ).run(Number(v), cid, user.id);
        reply(summary(cid, user.id));
        return true;
      }
      if (conv[2] === "leave" && method === "POST") {
        if (group(cid)) throw fail(400, "请使用群成员退出接口");
        db.prepare(
          "UPDATE dm_members SET hidden=1 WHERE conversationId=? AND userId=?",
        ).run(cid, user.id);
        send(user.id, "dm.conversation.left", { conversationId: cid });
        reply({ ok: true });
        return true;
      }
      if (!conv[2] && method === "GET") {
        reply(summary(cid, user.id));
        return true;
      }
      if (conv[2] === "messages" && method === "POST") {
        const g = group(cid);
        if (g?.mode === "channel" && g.ownerId !== user.id)
          throw fail(403, "频道仅群主可发布");
        const b = await body(req, 8 * 1048576);
        if (
          typeof b.content !== "string" ||
          !b.content.trim() ||
          b.content.length > 10000 ||
          typeof b.clientId !== "string" ||
          !b.clientId ||
          b.clientId.length > 100
        )
          throw fail(400, "消息需1–10000字和客户端标识");
        if (
          !group(cid) &&
          peers(cid).some(
            (id) => banned({ id }) || (id !== user.id && blocked(user.id, id)),
          )
        )
          throw fail(403, "对方账号不可用");
        const existing = db
          .prepare(
            "SELECT data,conversationId FROM dm_messages WHERE senderId=? AND clientId=?",
          )
          .get(user.id, b.clientId);
        if (existing) {
          if (existing.conversationId !== cid) throw fail(409, "重复消息标识");
          reply(JSON.parse(existing.data));
          return true;
        }
        let replyTo = null;
        if (b.replyToId) {
          const row = db
            .prepare(
              "SELECT data FROM dm_messages WHERE id=? AND conversationId=?",
            )
            .get(b.replyToId, cid);
          if (
            !row ||
            !db
              .prepare("SELECT 1 FROM dm_messages WHERE id=? AND rowid>?")
              .get(b.replyToId, member(cid, user.id).joinedSeq)
          )
            throw fail(400, "引用消息无效");
          const m = JSON.parse(row.data);
          replyTo = {
            id: m.id,
            senderId: m.senderId,
            content: m.withdrawnAt ? "" : m.content,
            withdrawn: !!m.withdrawnAt,
          };
        }
        let attachment = null,
          bytes = null;
        if (b.attachment) {
          const a = b.attachment;
          if (
            typeof a.name !== "string" ||
            !a.name.trim() ||
            a.name.length > 180 ||
            /[\x00-\x1f]/.test(a.name) ||
            typeof a.mime !== "string" ||
            typeof a.data !== "string" ||
            !a.data ||
            a.data.length > 7 * 1048576 ||
            /[^A-Za-z0-9+/=]/.test(a.data)
          )
            throw fail(400, "无效附件");
          bytes = Buffer.from(a.data, "base64");
          if (bytes.toString("base64") !== a.data)
            throw fail(400, "无效附件编码");
          if (bytes.length > 5 * 1048576) throw fail(413, "文件最多5MB");
          if (!bytes.length) throw fail(400, "文件为空");
          if (
            db
              .prepare(
                "SELECT COALESCE(SUM(length(bytes)),0) n FROM dm_attachments WHERE ownerId=?",
              )
              .get(user.id).n +
              bytes.length >
            100 * 1048576
          )
            throw fail(413, "附件空间已满（每账号100MB）");
          const image =
            (a.mime === "image/png" &&
              bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
            (a.mime === "image/jpeg" &&
              bytes[0] === 255 &&
              bytes[1] === 216 &&
              bytes[2] === 255) ||
            (a.mime === "image/gif" &&
              ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) ||
            (a.mime === "image/webp" &&
              bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP");
          const audio = [
            "audio/webm",
            "audio/ogg",
            "audio/mpeg",
            "audio/wav",
            "audio/mp4",
          ].includes(a.mime);
          if (a.mime.startsWith("image/") && !image)
            throw fail(400, "不支持的图片或文件格式不符");
          attachment = {
            name: a.name,
            size: bytes.length,
            mime: image || audio ? a.mime : "application/octet-stream",
            type: image ? "image" : audio ? "audio" : "file",
          };
        }
        const msg = {
          id: randomUUID(),
          conversationId: cid,
          senderId: user.id,
          kind: "text",
          content: b.content,
          createdAt: now(),
          replyTo,
          ...(attachment ? { attachment, kind: attachment.type } : {}),
        };
        if (attachment) attachment.url = `/v1/dm/attachments/${msg.id}`;
        transaction(() => {
          if (bytes)
            db.prepare("INSERT INTO dm_attachments VALUES(?,?,?)").run(
              msg.id,
              user.id,
              bytes,
            );
          db.prepare("INSERT INTO dm_messages VALUES(?,?,?,?,?)").run(
            msg.id,
            cid,
            user.id,
            b.clientId,
            JSON.stringify(msg),
          );
          db.prepare(
            "UPDATE dm_members SET hidden=0 WHERE conversationId=?",
          ).run(cid);
        });
        notify(cid, "dm.message.created", msg);
        reply(msg, 201);
        return true;
      }
    }
    const pins = path.match(/^\/v1\/dm\/conversations\/([^/]+)\/pins$/);
    if (pins && method === "GET") {
      const cid = decodeURIComponent(pins[1]),
        m = member(cid, user.id);
      reply({
        items: db
          .prepare(
            "SELECT d.data FROM dm_pins p JOIN dm_messages d ON d.id=p.messageId WHERE p.conversationId=? AND d.rowid>? ORDER BY p.createdAt DESC LIMIT 50",
          )
          .all(cid, m.joinedSeq)
          .map((r) => messageView(r.data)),
      });
      return true;
    }
    const pin = path.match(/^\/v1\/dm\/messages\/([^/]+)\/pin$/);
    if (pin && ["PUT", "DELETE"].includes(method)) {
      const row = db
        .prepare("SELECT rowid seq,* FROM dm_messages WHERE id=?")
        .get(decodeURIComponent(pin[1]));
      if (!row) throw fail(404, "消息不存在");
      const m = member(row.conversationId, user.id);
      if (row.seq <= m.joinedSeq || JSON.parse(row.data).withdrawnAt)
        throw fail(404, "消息不可用");
      if (group(row.conversationId)) owned(row.conversationId, user.id);
      if (method === "PUT") {
        if (
          db
            .prepare("SELECT count(*) n FROM dm_pins WHERE conversationId=?")
            .get(row.conversationId).n >= 50 &&
          !db.prepare("SELECT 1 FROM dm_pins WHERE messageId=?").get(row.id)
        )
          throw fail(400, "最多置顶50条消息");
        db.prepare("INSERT OR IGNORE INTO dm_pins VALUES(?,?,?,?)").run(
          row.conversationId,
          row.id,
          user.id,
          now(),
        );
      } else db.prepare("DELETE FROM dm_pins WHERE messageId=?").run(row.id);
      notify(row.conversationId, "dm.message.pinned");
      reply({ ok: true });
      return true;
    }
    const message = path.match(/^\/v1\/dm\/messages\/([^/]+)$/);
    if (message && ["PATCH", "DELETE"].includes(method)) {
      const row = db
        .prepare("SELECT * FROM dm_messages WHERE id=?")
        .get(decodeURIComponent(message[1]));
      if (!row) throw fail(404, "消息不存在");
      member(row.conversationId, user.id);
      if (row.senderId !== user.id) throw fail(403, "只能修改自己的消息");
      const msg = JSON.parse(row.data);
      if (msg.withdrawnAt) throw fail(409, "消息已经撤回");
      if (method === "PATCH") {
        const b = await body(req);
        if (
          typeof b.content !== "string" ||
          !b.content.trim() ||
          b.content.length > 10000
        )
          throw fail(400, "无效消息");
        msg.content = b.content;
        msg.editedAt = now();
      } else {
        msg.content = "";
        msg.withdrawnAt = now();
        delete msg.attachment;
        db.prepare("DELETE FROM dm_pins WHERE messageId=?").run(msg.id);
        db.prepare("DELETE FROM dm_attachments WHERE messageId=?").run(msg.id);
      }
      db.prepare("UPDATE dm_messages SET data=? WHERE id=?").run(
        JSON.stringify(msg),
        msg.id,
      );
      notify(
        row.conversationId,
        method === "PATCH" ? "dm.message.edited" : "dm.message.withdrawn",
        msg,
      );
      reply(msg);
      return true;
    }
    throw fail(404, "敲敲接口不存在");
  };
  return {
    handler,
    typing(cid, uid) {
      member(cid, uid);
      if (
        !group(cid) &&
        peers(cid).some((id) => id !== uid && blocked(uid, id))
      )
        return;
      for (const id of peers(cid))
        if (id !== uid)
          send(id, "dm.typing", { conversationId: cid, userId: uid });
    },
  };
}
