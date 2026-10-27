import { randomUUID, createHash } from "node:crypto";
const fail = (status, message) => Object.assign(new Error(message), { status });
const thresholds = [0, 500, 2000, 6000, 15000, 35000, 80000];
// Sign-in day turns at 04:00 Asia/Shanghai, not server-local midnight.
export const checkInDay = (now = Date.now()) =>
  new Date(now + 4 * 3600000).toISOString().slice(0, 10);
const today = checkInDay;
export function resolveVideo(source) {
  if (typeof source !== "string" || source.length > 2048)
    throw fail(400, "无效视频链接");
  let id = source.trim(),
    page = 1;
  if (/^https:\/\//.test(id)) {
    let u;
    try {
      u = new URL(id);
    } catch {
      throw fail(400, "无效视频链接");
    }
    if (
      !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(
        u.hostname,
      ) ||
      u.username ||
      u.password ||
      u.port
    )
      throw fail(400, "只支持B站官方视频链接");
    const m = u.pathname.match(
      /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,14})\/?$/,
    );
    if (!m) throw fail(400, "无效视频地址");
    id = m[1];
    page = Number(u.searchParams.get("p") || 1);
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
    throw fail(400, "无效视频分P");
  let bvid = null,
    aid = null;
  if (/^BV[A-Za-z0-9]{10}$/.test(id)) bvid = id;
  else if (/^av[1-9]\d{0,14}$/.test(id)) aid = Number(id.slice(2));
  else throw fail(400, "无效视频编号");
  const q = new URLSearchParams(bvid ? { bvid } : { aid: String(aid) });
  q.set("page", String(page));
  q.set("autoplay", "0");
  return {
    provider: "bilibili",
    bvid,
    aid,
    page,
    p: page,
    cid: null,
    embedUrl: "https://player.bilibili.com/player.html?" + q,
    coverUrl: null,
    title: null,
    duration: null,
    metadataAvailable: false,
  };
}
export function validateVideos(videos) {
  if (!Array.isArray(videos) || videos.length > 1)
    throw fail(400, "最多嵌入一个视频");
  return videos.map((v) => {
    if (typeof v === "string") return resolveVideo(v);
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      v.provider !== "bilibili"
    )
      throw fail(400, "无效视频数据");
    const id =
      v.bvid || (Number.isSafeInteger(v.aid) && v.aid > 0 ? "av" + v.aid : "");
    const page = v.p ?? v.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
      throw fail(400, "无效视频分P");
    return resolveVideo("https://www.bilibili.com/video/" + id + "?p=" + page);
  });
}
export function createCommunity(
  db,
  { profiles, admin, publicUser, uploads, broadcast = () => {} },
) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_actions(userId TEXT,day TEXT,action TEXT,exp INTEGER,PRIMARY KEY(userId,day,action));
 CREATE TABLE IF NOT EXISTS checkins(userId TEXT,day TEXT,streak INTEGER,createdAt TEXT,PRIMARY KEY(userId,day));
 CREATE TABLE IF NOT EXISTS money_logs(id TEXT PRIMARY KEY,userId TEXT,action TEXT,amount INTEGER,balance INTEGER,description TEXT,createdAt TEXT);
 CREATE TABLE IF NOT EXISTS post_coins(userId TEXT,postId TEXT,PRIMARY KEY(userId,postId));
 CREATE TABLE IF NOT EXISTS user_follows(userId TEXT,peerId TEXT,createdAt TEXT,PRIMARY KEY(userId,peerId));
 CREATE TABLE IF NOT EXISTS feed_blocks(userId TEXT,peerId TEXT,createdAt TEXT,PRIMARY KEY(userId,peerId));
 CREATE TABLE IF NOT EXISTS post_reads(userId TEXT,postId TEXT,createdAt TEXT,PRIMARY KEY(userId,postId));
 CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,userId TEXT,type TEXT,targetId TEXT,reason TEXT,detail TEXT,state TEXT,createdAt TEXT,UNIQUE(userId,type,targetId));
 CREATE TABLE IF NOT EXISTS user_cosmetics(userId TEXT PRIMARY KEY,cardId TEXT);
 CREATE TABLE IF NOT EXISTS profile_pins(userId TEXT PRIMARY KEY,data TEXT);
 CREATE TABLE IF NOT EXISTS transfer_requests(userId TEXT,clientId TEXT,data TEXT,PRIMARY KEY(userId,clientId));
 CREATE TABLE IF NOT EXISTS session_info(token TEXT PRIMARY KEY,userAgent TEXT,ip TEXT,createdAt TEXT);`);
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const json = (row) => row && JSON.parse(row.data);
  function post(id) {
    const p = json(db.prepare("SELECT data FROM posts WHERE id=?").get(id));
    if (!p || p.status === "draft") throw fail(404, "帖子不存在或未发布");
    return p;
  }
  function user(id) {
    const u = db.prepare("SELECT id,username FROM users WHERE id=?").get(id);
    if (!u) throw fail(404, "用户不存在");
    return u;
  }
  function ledger(uid, amount, action, description) {
    const p = profiles.get(uid),
      balance = p.denny + amount;
    if (!Number.isSafeInteger(balance) || balance < 0 || balance > 1e12)
      throw fail(400, "丁尼余额不足或超出上限");
    profiles.set(uid, { denny: balance });
    db.prepare("INSERT INTO money_logs VALUES(?,?,?,?,?,?,?)").run(
      randomUUID(),
      uid,
      action,
      amount,
      balance,
      description,
      new Date().toISOString(),
    );
    return balance;
  }
  function award(uid, action, exp) {
    const day = today();
    if (
      db
        .prepare(
          "SELECT 1 FROM daily_actions WHERE userId=? AND day=? AND action=?",
        )
        .get(uid, day, action)
    )
      return 0;
    const used = db
      .prepare(
        "SELECT coalesce(sum(exp),0) n FROM daily_actions WHERE userId=? AND day=?",
      )
      .get(uid, day).n;
    const gained = Math.max(0, Math.min(exp, 50 - used)),
      p = profiles.get(uid),
      total = p.exp + gained;
    db.prepare("INSERT INTO daily_actions VALUES(?,?,?,?)").run(
      uid,
      day,
      action,
      gained,
    );
    profiles.set(uid, {
      exp: total,
      level: Math.max(p.level, thresholds.filter((x) => total >= x).length),
    });
    return gained;
  }
  const has = (table, uid, id) => {
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE userId=? AND ${table === "post_reads" ? "postId" : "peerId"}=?`,
        )
        .get(uid, id)
    )
      return true;
    return (
      table === "feed_blocks" &&
      !!db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='dm_relationships'",
        )
        .get() &&
      !!db
        .prepare(
          "SELECT 1 FROM dm_relationships WHERE ownerId=? AND peerId=? AND blocked=1",
        )
        .get(uid, id)
    );
  };
  function coin(uid, p) {
    if (p.authorId === uid) throw fail(400, "不能给自己的委托投币");
    if (
      db
        .prepare("SELECT 1 FROM post_coins WHERE userId=? AND postId=?")
        .get(uid, p.id)
    )
      throw fail(409, "已经投币");
    const balance = ledger(uid, -1, "post_coin", `向委托 ${p.id} 投币`);
    db.prepare("INSERT INTO post_coins VALUES(?,?)").run(uid, p.id);
    if (db.prepare("SELECT 1 FROM users WHERE id=?").get(p.authorId))
      ledger(p.authorId, 1, "post_income", `委托 ${p.id} 收到投币`);
    return balance;
  }
  const coins = (id) =>
    db.prepare("SELECT count(*) n FROM post_coins WHERE postId=?").get(id).n;
  const view = (p) => ({
    ...p,
    ...(p.isAnonymous ? { authorId: "" } : {}),
    author: p.isAnonymous
      ? {
          id: "",
          anonymous: true,
          name: "匿名绳匠",
          avatarUrl: "/images/default-avatar.webp",
        }
      : publicUser(
          db
            .prepare("SELECT id,username FROM users WHERE id=?")
            .get(p.authorId) || { id: p.authorId, username: "绳匠" },
        ),
    cover: p.covers?.[0] || null,
    tags: (p.tags || []).map((t) =>
      typeof t === "string" ? { name: t, slug: t } : t,
    ),
  });
  function page(items, url) {
    const offset = Math.max(
        0,
        Math.floor(Number(url.searchParams.get("cursor")) || 0),
      ),
      limit = Math.max(
        1,
        Math.min(100, Math.floor(Number(url.searchParams.get("limit")) || 20)),
      );
    return {
      items: items.slice(offset, offset + limit),
      nextCursor: offset + limit < items.length ? String(offset + limit) : null,
    };
  }
  function enrich(p, uid) {
    return {
      isRead: !!uid && has("post_reads", uid, p.id),
      dennyGiven:
        !!uid &&
        !!db
          .prepare("SELECT 1 FROM post_coins WHERE userId=? AND postId=?")
          .get(uid, p.id),
      dennyCount: coins(p.id),
      isAnonymous: !!p.isAnonymous,
    };
  }
  function benefits(uid) {
    const level = Math.max(0, Math.min(7, uid ? profiles.get(uid).level : 0));
    return {
      level,
      maxLevel: 7,
      benefits: {
        postMaxImages: [0, 9, 12, 15, 18, 24, 30, 40][level],
        commentMaxImages: [0, 3, 6, 9, 9, 12, 12, 18][level],
        postMaxBodyChars: [0, 3000, 4000, 6000, 8000, 10000, 13000, 16000][
          level
        ],
      },
    };
  }
  function validatePost(b, uid) {
    const limits = benefits(uid).benefits;
    if (
      typeof b.body !== "string" ||
      b.body.length > limits.postMaxBodyChars ||
      (b.coverIds?.length || 0) > limits.postMaxImages
    )
      throw fail(400, "超过当前等级的正文或封面配额");
  }
  async function handler({
    path,
    req,
    url,
    auth,
    body,
    reply,
    user: actor,
    token,
  }) {
    const method = req.method;
    if (path === "/v1/videos/resolve" && method === "GET") {
      auth();
      reply({
        video: resolveVideo(url.searchParams.get("source")),
        pages: [],
        metadataAvailable: false,
      });
      return true;
    }

    const avatars = [
      ["nicole", "妮可"],
      ["anby", "安比"],
      ["billy", "比利"],
    ].map(([id, name]) => ({
      id: "avatar-" + id,
      name,
      kind: "character",
      image: { url: `/images/agent-${id}.webp`, width: 256, height: 256 },
    }));
    if (path === "/v1/me/avatars" && method === "GET") {
      const u = auth(),
        equipped = avatars.find(
          (a) => a.image.url === profiles.get(u.id).avatarUrl,
        );
      reply({ items: avatars, equippedAvatarId: equipped?.id || null });
      return true;
    }
    if (path === "/v1/me/avatars/equipped" && method === "PUT") {
      const u = auth(),
        b = await body(req),
        a = avatars.find((a) => a.id === b.avatarId);
      if (b.avatarId !== null && !a) throw fail(400, "头像不存在");
      profiles.set(u.id, { avatarUrl: a?.image.url || "" });
      reply({ equippedAvatarId: a?.id || null });
      return true;
    }
    const cards = [
      {
        id: "card-interknot",
        name: "绳网",
        kind: "city",
        image: { url: "/images/zzz.webp", width: 1921, height: 1537 },
      },
    ];
    if (path === "/v1/me/cards" && method === "GET") {
      const u = auth(),
        id = db
          .prepare("SELECT cardId FROM user_cosmetics WHERE userId=?")
          .get(u.id)?.cardId;
      reply({
        items: cards,
        nextCursor: null,
        equippedCard: cards.find((c) => c.id === id) || null,
      });
      return true;
    }

    if (path === "/v1/me/cards/equipped" && method === "PUT") {
      const u = auth(),
        b = await body(req);
      if (b.cardId !== null && !cards.some((c) => c.id === b.cardId))
        throw fail(400, "名片不存在");
      db.prepare("INSERT OR REPLACE INTO user_cosmetics VALUES(?,?)").run(
        u.id,
        b.cardId,
      );
      reply({ ok: true });
      return true;
    }
    if (path === "/v1/exam" && method === "GET") {
      auth();
      reply({
        passed: true,
        required: false,
        cooldownRemainingSecs: 0,
        activeAttempt: null,
      });
      return true;
    }
    const remove = path.match(/^\/v1\/(posts|comments)\/([^/]+)$/);
    if (remove && method === "DELETE") {
      const u = auth(),
        table = remove[1],
        row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(remove[2]);
      if (!row) throw fail(404, "内容不存在");
      const record = json(row);
      if (record.authorId !== u.id && !admin.isAdmin(u))
        throw fail(403, "只能删除自己的内容");
      transaction(() => {
        if (table === "posts") {
          for (const c of db
            .prepare("SELECT id FROM comments WHERE postId=?")
            .all(row.id))
            db.prepare("DELETE FROM reactions WHERE targetId=?").run(c.id);
          db.prepare("DELETE FROM comments WHERE postId=?").run(row.id);
          db.prepare("DELETE FROM post_reads WHERE postId=?").run(row.id);
        } else {
          const all = db
              .prepare("SELECT id,data FROM comments WHERE postId=?")
              .all(row.postId),
            ids = new Set([row.id]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const c of all)
              if (ids.has(json(c).parentId) && !ids.has(c.id)) {
                ids.add(c.id);
                changed = true;
              }
          }
          for (const id of ids) {
            db.prepare("DELETE FROM comments WHERE id=?").run(id);
            db.prepare("DELETE FROM reactions WHERE targetId=?").run(id);
          }
        }
        db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
        db.prepare("DELETE FROM reactions WHERE targetId=?").run(row.id);
      });
      broadcast("content.deleted", { id: row.id });
      reply({ ok: true });
      return true;
    }
    const comments = path.match(/^\/v1\/users\/([^/]+)\/comments$/);
    if (comments && method === "GET") {
      const uid = decodeURIComponent(comments[1]),
        p = profiles.get(uid);
      if (p.hidden && actor?.id !== uid && !admin.isAdmin(actor))
        throw fail(403, "个人空间未公开");
      reply(
        page(
          db
            .prepare("SELECT data FROM comments ORDER BY rowid DESC")
            .all()
            .map(json)
            .filter(
              (c) =>
                c.authorId === uid && (!c.isAnonymous || actor?.id === uid),
            )
            .filter((c) => {
              try {
                post(c.postId);
                return true;
              } catch {
                return false;
              }
            })
            .map((c) => ({ ...c, author: publicUser(user(uid)) })),
          url,
        ),
      );
      return true;
    }

    if (path === "/v1/benefits" && method === "GET") {
      reply(benefits(actor?.id));
      return true;
    }
    if (path === "/v1/me/check-in" && ["GET", "POST"].includes(method)) {
      const u = auth(),
        day = today(),
        existing = db
          .prepare("SELECT * FROM checkins WHERE userId=? AND day=?")
          .get(u.id, day);
      let expGained = 0,
        dennyGained = 0;
      if (method === "POST" && !existing)
        transaction(() => {
          const prev = db
              .prepare(
                "SELECT * FROM checkins WHERE userId=? ORDER BY day DESC LIMIT 1",
              )
              .get(u.id),
            yesterday = new Date(Date.parse(day + "T00:00:00Z") - 86400000)
              .toISOString()
              .slice(0, 10);
          db.prepare("INSERT INTO checkins VALUES(?,?,?,?)").run(
            u.id,
            day,
            prev?.day === yesterday ? prev.streak + 1 : 1,
            new Date().toISOString(),
          );
          ledger(u.id, 10, "check_in", "每日签到");
          expGained = award(
            u.id,
            "checkIn",
            Math.min(10, 6 + (prev?.day === yesterday ? prev.streak : 0)),
          );
          dennyGained = 10;
        });
      const row = db
          .prepare(
            "SELECT * FROM checkins WHERE userId=? ORDER BY day DESC LIMIT 1",
          )
          .get(u.id),
        count = db
          .prepare("SELECT count(*) n FROM checkins WHERE userId=?")
          .get(u.id).n,
        p = profiles.get(u.id),
        checked = row?.day === day,
        yesterday = new Date(Date.parse(day + "T00:00:00Z") - 86400000)
          .toISOString()
          .slice(0, 10),
        streak = checked || row?.day === yesterday ? row.streak : 0,
        nextStreak = checked ? streak : streak + 1;
      reply({
        canCheckIn: !checked,
        day,
        totalDays: count,
        streak,
        rank: checked
          ? db
              .prepare(
                "SELECT count(*) n FROM checkins WHERE day=? AND createdAt<=?",
              )
              .get(day, row.createdAt).n
          : 0,
        nextStreak,
        nextExp: Math.min(10, 5 + nextStreak),
        balance: p.denny,
        exp: p.exp,
        level: p.level,
        expGained,
        dennyGained,
        nextEligibleAt: new Date(
          Date.parse(day + "T00:00:00Z") + 20 * 3600000,
        ).toISOString(),
      });
      return true;
    }
    if (path === "/v1/me/exp" && method === "GET") {
      const u = auth(),
        p = profiles.get(u.id),
        rows = db
          .prepare("SELECT * FROM daily_actions WHERE userId=? AND day=?")
          .all(u.id, today());
      reply({
        ...p,
        todayActiveGained: rows.reduce((s, r) => s + r.exp, 0),
        todayActiveCap: 50,
        sources: Object.fromEntries(
          rows.map((r) => [r.action, { done: true, exp: r.exp }]),
        ),
      });
      return true;
    }
    if (path === "/v1/me/wallet" && method === "GET") {
      const u = auth();
      reply({
        balance: profiles.get(u.id).denny,
        given: db
          .prepare("SELECT count(*) n FROM post_coins WHERE userId=?")
          .get(u.id).n,
        polychrome: profiles.get(u.id).polychrome,
      });
      return true;
    }
    if (path === "/v1/me/denny-logs" && method === "GET") {
      reply(
        page(
          db
            .prepare(
              "SELECT * FROM money_logs WHERE userId=? ORDER BY rowid DESC",
            )
            .all(auth().id),
          url,
        ),
      );
      return true;
    }
    if (path === "/v1/me/transfers" && method === "POST") {
      const u = auth(),
        b = await body(req);
      if (
        typeof b.peerId !== "string" ||
        b.peerId === u.id ||
        !Number.isSafeInteger(b.amount) ||
        b.amount < 1 ||
        b.amount > 1000000 ||
        typeof b.clientId !== "string" ||
        !b.clientId ||
        b.clientId.length > 100
      )
        throw fail(400, "无效转账参数");
      const recipient = user(b.peerId);
      if (
        admin.banned?.(recipient) ||
        has("feed_blocks", u.id, b.peerId) ||
        has("feed_blocks", b.peerId, u.id)
      )
        throw fail(403, "收款账号不可用或存在屏蔽关系");
      const result = transaction(() => {
        const prior = json(
          db
            .prepare(
              "SELECT data FROM transfer_requests WHERE userId=? AND clientId=?",
            )
            .get(u.id, b.clientId),
        );
        if (prior) {
          if (prior.peerId !== b.peerId || prior.amount !== b.amount)
            throw fail(409, "转账标识已使用");
          return prior;
        }
        const balance = ledger(
          u.id,
          -b.amount,
          "transfer_out",
          `转给 ${b.peerId}`,
        );
        ledger(b.peerId, b.amount, "transfer_in", `来自 ${u.id}`);
        const result = {
          id: randomUUID(),
          peerId: b.peerId,
          amount: b.amount,
          balance,
        };
        db.prepare("INSERT INTO transfer_requests VALUES(?,?,?)").run(
          u.id,
          b.clientId,
          JSON.stringify(result),
        );
        return result;
      });
      reply(result);
      return true;
    }
    const donate = path.match(/^\/v1\/posts\/([^/]+)\/(denny|triple)$/);
    if (donate && method === "POST") {
      const u = auth(),
        p = post(donate[1]);
      const result = transaction(() => {
        if (donate[2] === "denny")
          return { balance: coin(u.id, p), dennyCount: coins(p.id) };
        for (const kind of ["like", "favorite"])
          db.prepare("INSERT OR IGNORE INTO reactions VALUES(?,?,?)").run(
            u.id,
            p.id,
            kind,
          );
        let given = false,
          dennyError = "";
        if (p.authorId === u.id) dennyError = "SELF";
        else if (
          db
            .prepare("SELECT 1 FROM post_coins WHERE userId=? AND postId=?")
            .get(u.id, p.id)
        )
          dennyError = "ALREADY_GIVEN";
        else if (profiles.get(u.id).denny < 1)
          dennyError = "INSUFFICIENT_BALANCE";
        else {
          coin(u.id, p);
          given = true;
        }
        return {
          liked: true,
          favorited: true,
          likeCount:
            (p.likeCount || 0) +
            db
              .prepare(
                "SELECT count(*) n FROM reactions WHERE targetId=? AND kind='like'",
              )
              .get(p.id).n,
          favoriteCount:
            (p.favoriteCount || 0) +
            db
              .prepare(
                "SELECT count(*) n FROM reactions WHERE targetId=? AND kind='favorite'",
              )
              .get(p.id).n,
          dennyGiven: given,
          dennyError,
          dennyCount: coins(p.id),
          balance: profiles.get(u.id).denny,
        };
      });
      reply(result);
      return true;
    }
    if (path === "/v1/me/reads" && method === "POST") {
      const u = auth(),
        b = await body(req);
      if (
        !Array.isArray(b.postIds) ||
        b.postIds.length > 100 ||
        b.postIds.some((id) => typeof id !== "string")
      )
        throw fail(400, "无效已读列表");
      for (const id of b.postIds) post(id);
      transaction(() => {
        for (const id of b.postIds)
          db.prepare("INSERT OR REPLACE INTO post_reads VALUES(?,?,?)").run(
            u.id,
            id,
            new Date().toISOString(),
          );
      });
      reply({ ok: true });
      return true;
    }
    const follow = path.match(/^\/v1\/users\/([^/]+)\/(follow|block)$/);
    if (follow && ["PUT", "DELETE"].includes(method)) {
      const u = auth(),
        peer = user(decodeURIComponent(follow[1]));
      if (peer.id === u.id) throw fail(400, "不能操作自己");
      const table = follow[2] === "follow" ? "user_follows" : "feed_blocks";
      if (method === "PUT")
        db.prepare(`INSERT OR IGNORE INTO ${table} VALUES(?,?,?)`).run(
          u.id,
          peer.id,
          new Date().toISOString(),
        );
      else
        db.prepare(`DELETE FROM ${table} WHERE userId=? AND peerId=?`).run(
          u.id,
          peer.id,
        );
      if (
        follow[2] === "block" &&
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='dm_relationships'")
          .get()
      )
        db.prepare(
          "INSERT INTO dm_relationships(ownerId,peerId,blocked) VALUES(?,?,?) ON CONFLICT(ownerId,peerId) DO UPDATE SET blocked=excluded.blocked",
        ).run(u.id, peer.id, method === "PUT" ? 1 : 0);
      reply({
        following: has("user_follows", u.id, peer.id),
        blocked: has("feed_blocks", u.id, peer.id),
        followerCount: db
          .prepare("SELECT count(*) n FROM user_follows WHERE peerId=?")
          .get(peer.id).n,
      });
      return true;
    }
    if (path === "/v1/me/relations" && method === "GET") {
      const u = auth(),
        ids = (url.searchParams.get("userIds") || "")
          .split(",")
          .filter(Boolean);
      if (ids.length > 100) throw fail(400, "最多100个用户");
      reply(
        ids.map((id) => ({
          userId: id,
          following: has("user_follows", u.id, id),
          blocking: has("feed_blocks", u.id, id),
        })),
      );
      return true;
    }
    if (path === "/v1/me/blocks" && method === "GET") {
      const u = auth();
      reply(
        page(
          db
            .prepare(
              "SELECT u.id,u.username,b.createdAt since FROM feed_blocks b JOIN users u ON u.id=b.peerId WHERE b.userId=? ORDER BY b.rowid DESC",
            )
            .all(u.id),
          url,
        ),
      );
      return true;
    }
    if (path === "/v1/feed/following" && method === "GET") {
      const u = auth();
      reply(
        page(
          db
            .prepare("SELECT data FROM posts ORDER BY rowid DESC")
            .all()
            .map(json)
            .filter(
              (p) =>
                p.status !== "draft" &&
                !p.isAnonymous &&
                has("user_follows", u.id, p.authorId) &&
                !has("feed_blocks", u.id, p.authorId),
            )
            .map((p) => ({ ...view(p), ...enrich(p, u.id) })),
          url,
        ),
      );
      return true;
    }
    if (
      ["/v1/tags/suggest", "/v1/search/suggest"].includes(path) &&
      method === "GET"
    ) {
      const q = (url.searchParams.get("q") || "").slice(0, 100).toLowerCase();
      const posts = db
        .prepare("SELECT data FROM posts")
        .all()
        .map(json)
        .filter((p) => p.status !== "draft");
      const tags = [...new Set(posts.flatMap((p) => p.tags || []))]
        .filter((t) => typeof t === "string" && t.toLowerCase().includes(q))
        .slice(0, 20);
      reply(
        path.includes("tags")
          ? tags.map((name) => ({ name, slug: name }))
          : posts
              .filter((p) => p.title.toLowerCase().includes(q))
              .slice(0, 10)
              .map(view),
      );
      return true;
    }
    if (path === "/v1/users/mention-candidates" && method === "GET") {
      auth();
      const q = (url.searchParams.get("q") || "").slice(0, 100);
      reply({
        items: db
          .prepare(
            "SELECT id,username FROM users WHERE username LIKE ? LIMIT 20",
          )
          .all("%" + q + "%")
          .map(publicUser),
        nextCursor: null,
      });
      return true;
    }
    if (path === "/v1/reports" && method === "POST") {
      const u = auth(),
        b = await body(req);
      if (
        !["post", "comment", "user"].includes(b.targetType) ||
        typeof b.targetId !== "string" ||
        typeof b.reason !== "string" ||
        !b.reason.trim() ||
        b.reason.length > 200 ||
        typeof (b.detail || "") !== "string" ||
        (b.detail || "").length > 2000
      )
        throw fail(400, "无效举报");
      if (b.targetType === "post") post(b.targetId);
      if (b.targetType === "user") user(b.targetId);
      if (b.targetType === "comment") {
        const row = db
          .prepare("SELECT postId FROM comments WHERE id=?")
          .get(b.targetId);
        if (!row) throw fail(404, "评论不存在");
        post(row.postId);
      }
      const old = db
        .prepare(
          "SELECT id FROM reports WHERE userId=? AND type=? AND targetId=?",
        )
        .get(u.id, b.targetType, b.targetId);
      const id = old?.id || randomUUID();
      if (!old)
        db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
          id,
          u.id,
          b.targetType,
          b.targetId,
          b.reason,
          b.detail || "",
          "open",
          new Date().toISOString(),
        );
      reply({ id });
      return true;
    }
    if (path === "/v1/reports/check" && method === "GET") {
      const u = auth(),
        ids = (url.searchParams.get("ids") || "").split(",");
      if (ids.length > 100) throw fail(400, "最多100条");
      reply({
        reported: Object.fromEntries(
          ids.map((id) => [
            id,
            !!db
              .prepare(
                "SELECT 1 FROM reports WHERE userId=? AND type=? AND targetId=?",
              )
              .get(u.id, url.searchParams.get("targetType"), id),
          ]),
        ),
      });
      return true;
    }
    if (path === "/v1/admin/reports" && method === "GET") {
      const u = auth();
      if (!admin.isAdmin(u)) throw fail(403, "需要管理员权限");
      const rows = db
          .prepare("SELECT * FROM reports ORDER BY rowid DESC")
          .all(),
        offset =
          (Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)) -
            1) *
          30;
      reply({ items: rows.slice(offset, offset + 30), total: rows.length });
      return true;
    }
    const report = path.match(/^\/v1\/admin\/reports\/([^/]+)$/);
    if (report && method === "PATCH") {
      const u = auth();
      if (!admin.isAdmin(u)) throw fail(403, "需要管理员权限");
      const b = await body(req);
      if (!["open", "resolved", "dismissed"].includes(b.state))
        throw fail(400, "无效举报状态");
      if (!db.prepare("SELECT 1 FROM reports WHERE id=?").get(report[1]))
        throw fail(404, "举报不存在");
      transaction(() => {
        db.prepare("UPDATE reports SET state=? WHERE id=?").run(
          b.state,
          report[1],
        );
        db.prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?)").run(
          randomUUID(),
          u.id,
          "report.review",
          JSON.stringify({ id: report[1], state: b.state }),
          new Date().toISOString(),
        );
      });
      reply({ ok: true });
      return true;
    }
    if (path === "/v1/me/mihoyo" && method === "GET") {
      auth();
      reply({ binding: null, configured: false });
      return true;
    }
    if (path === "/v1/capabilities" && method === "GET") {
      reply({
        localAccounts: true,
        checkIn: true,
        transfers: true,
        tasks: true,
        inAppNotifications: true,
        emailVerification: false,
        mihoyoQr: false,
        webRtc: false,
        redPackets: false,
        nativeDesktop: false,
        mobilePackages: false,
      });
      return true;
    }
    if (path === "/v1/me/security" && method === "GET") {
      auth();
      reply({ hasPassword: true, email: null, mihoyoBound: false });
      return true;
    }
    if (path === "/v1/me/sessions" && method === "GET") {
      const u = auth(),
        items = db
          .prepare(
            "SELECT s.*,i.userAgent,i.ip,i.createdAt FROM sessions s LEFT JOIN session_info i ON s.token=i.token WHERE s.userId=? AND s.expires>? ORDER BY s.rowid DESC",
          )
          .all(u.id, Date.now())
          .map((s) => ({
            id: createHash("sha256").update(s.token).digest("hex"),
            current: s.token === token,
            userAgent: s.userAgent || "",
            ip: s.ip || "",
            createdAt: s.createdAt || null,
            expiresAt: new Date(s.expires).toISOString(),
            loginMethod: "local",
          }));
      reply({ items, nextCursor: null });
      return true;
    }
    const revoke = path.match(/^\/v1\/me\/sessions\/([a-f0-9]{64})$/);
    if (revoke && method === "DELETE") {
      const u = auth(),
        s = db
          .prepare("SELECT token FROM sessions WHERE userId=?")
          .all(u.id)
          .find(
            (s) =>
              createHash("sha256").update(s.token).digest("hex") === revoke[1],
          );
      if (!s) throw fail(404, "会话不存在");
      db.prepare("DELETE FROM sessions WHERE token=?").run(s.token);
      reply({ ok: true });
      return true;
    }
    if (path === "/v1/me/sessions/revoke-others" && method === "POST") {
      const u = auth();
      db.prepare("DELETE FROM sessions WHERE userId=? AND token<>?").run(
        u.id,
        token || "",
      );
      reply({ ok: true });
      return true;
    }
    if (path === "/v1/me/username" && method === "PUT") {
      const u = auth(),
        b = await body(req);
      if (
        typeof b.username !== "string" ||
        b.username.trim().length < 2 ||
        b.username.length > 40
      )
        throw fail(400, "名称需要2至40字");
      profiles.set(u.id, { nickname: b.username.trim() });
      reply({ username: b.username.trim() });
      return true;
    }
    if (path === "/v1/me/profile/pinned-posts" && method === "PUT") {
      const u = auth(),
        b = await body(req);
      if (
        b.postIds !== null &&
        (!Array.isArray(b.postIds) ||
          b.postIds.length > 6 ||
          new Set(b.postIds).size !== b.postIds.length)
      )
        throw fail(400, "最多6条不同展示委托");
      for (const id of b.postIds || []) {
        if (typeof id !== "string" || post(id).authorId !== u.id)
          throw fail(403, "仅可展示自己的已发布委托");
      }
      db.prepare("INSERT OR REPLACE INTO profile_pins VALUES(?,?)").run(
        u.id,
        JSON.stringify(b.postIds),
      );
      reply({ pinnedPostIds: b.postIds });
      return true;
    }
    if (path === "/v1/me/profile/pin-candidates" && method === "GET") {
      const u = auth(),
        q = (url.searchParams.get("q") || "").toLowerCase();
      reply(
        page(
          db
            .prepare("SELECT data FROM posts ORDER BY rowid DESC")
            .all()
            .map(json)
            .filter(
              (p) =>
                p.authorId === u.id &&
                p.status !== "draft" &&
                p.title.toLowerCase().includes(q),
            )
            .map(view),
          url,
        ),
      );
      return true;
    }
    const flags = path.match(/^\/v1\/comments\/([^/]+)\/(pin|accept)$/);
    if (flags && ["PUT", "DELETE"].includes(method)) {
      const u = auth(),
        row = db.prepare("SELECT * FROM comments WHERE id=?").get(flags[1]);
      if (!row) throw fail(404, "评论不存在");
      const p = post(row.postId);
      if (p.authorId !== u.id && !admin.isAdmin(u))
        throw fail(403, "只有委托作者可管理评论");
      transaction(() => {
        if (method === "PUT")
          for (const other of db
            .prepare("SELECT * FROM comments WHERE postId=?")
            .all(row.postId)) {
            const c = json(other);
            c[flags[2] === "pin" ? "pinned" : "accepted"] = false;
            db.prepare("UPDATE comments SET data=? WHERE id=?").run(
              JSON.stringify(c),
              other.id,
            );
          }
        const c = json(row);
        c[flags[2] === "pin" ? "pinned" : "accepted"] = method === "PUT";
        db.prepare("UPDATE comments SET data=? WHERE id=?").run(
          JSON.stringify(c),
          row.id,
        );
      });
      reply({ ok: true });
      return true;
    }
    const misc = path.match(/^\/v1\/posts\/([^/]+)\/(views|related|pin)$/);
    if (misc) {
      const p = post(misc[1]);
      if (misc[2] === "views" && method === "POST") {
        const u = actor?.id || req.socket?.remoteAddress || "guest",
          key = `view:${p.id}`;
        const day = today();
        const count = transaction(() => {
          if (
            !db
              .prepare(
                "SELECT 1 FROM daily_actions WHERE userId=? AND day=? AND action=?",
              )
              .get(u, day, key)
          ) {
            db.prepare("INSERT INTO daily_actions VALUES(?,?,?,0)").run(
              u,
              day,
              key,
            );
            p.viewCount = (p.viewCount || 0) + 1;
            db.prepare("UPDATE posts SET data=? WHERE id=?").run(
              JSON.stringify(p),
              p.id,
            );
          }
          return p.viewCount || 0;
        });
        reply({ viewCount: count });
        return true;
      }
      if (misc[2] === "related" && method === "GET") {
        reply({
          items: db
            .prepare("SELECT data FROM posts ORDER BY rowid DESC")
            .all()
            .map(json)
            .filter(
              (x) =>
                x.id !== p.id &&
                x.status !== "draft" &&
                x.categoryId === p.categoryId,
            )
            .slice(0, 8)
            .map(view),
          nextCursor: null,
        });
        return true;
      }
      if (misc[2] === "pin" && ["PUT", "DELETE"].includes(method)) {
        const u = auth();
        if (p.authorId !== u.id && !admin.isAdmin(u))
          throw fail(403, "没有管理权限");
        p.pinned = method === "PUT";
        db.prepare("UPDATE posts SET data=? WHERE id=?").run(
          JSON.stringify(p),
          p.id,
        );
        reply({ pinned: p.pinned });
        return true;
      }
    }
    return false;
  }
  return {
    handler,
    benefits,
    validatePost,
    award,
    post,
    enrich,
    following: (u, id) => has("user_follows", u, id),
    blocked: (u, id) => has("feed_blocks", u, id),
    pins: (uid) =>
      json(
        db.prepare("SELECT data FROM profile_pins WHERE userId=?").get(uid),
      ) ?? null,
  };
}
