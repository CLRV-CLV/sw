import { randomInt, randomUUID } from "node:crypto";
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createPremium(
  db,
  profiles,
  { roll = () => randomInt(11) } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS cosmetic_purchases(userId TEXT,kind TEXT,mediaId TEXT,PRIMARY KEY(userId,kind,mediaId));
 CREATE TABLE IF NOT EXISTS custom_cards(id TEXT PRIMARY KEY,userId TEXT,data TEXT);
 CREATE TABLE IF NOT EXISTS user_cosmetics(userId TEXT PRIMARY KEY,cardId TEXT);
 CREATE TABLE IF NOT EXISTS reviewed_posts(postId TEXT PRIMARY KEY,userId TEXT,approvedAt TEXT);
 CREATE TABLE IF NOT EXISTS premium_rewards(userId TEXT,batch INTEGER,amount INTEGER,PRIMARY KEY(userId,batch));
 CREATE TABLE IF NOT EXISTS polychrome_logs(id TEXT PRIMARY KEY,userId TEXT,action TEXT,amount INTEGER,balance INTEGER,description TEXT,createdAt TEXT);`);
  const transaction = (fn) => {
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  function ledger(uid, delta, action, description) {
    const old = profiles.get(uid).polychrome,
      balance = old + delta;
    if (!Number.isSafeInteger(balance) || balance < 0 || balance > 1e12)
      throw fail(409, "菲林不足，需要20菲林");
    profiles.set(uid, { polychrome: balance });
    db.prepare("INSERT INTO polychrome_logs VALUES(?,?,?,?,?,?,?)").run(
      randomUUID(),
      uid,
      action,
      delta,
      balance,
      description,
      new Date().toISOString(),
    );
    return balance;
  }
  function purchase(uid, kind, mediaId, apply) {
    return transaction(() => {
      const prior = db
        .prepare(
          "SELECT 1 FROM cosmetic_purchases WHERE userId=? AND kind=? AND mediaId=?",
        )
        .get(uid, kind, mediaId);
      if (!prior) {
        ledger(
          uid,
          -20,
          "cosmetic_upload",
          kind === "avatar" ? "上传自定义头像" : "上传自定义名片",
        );
        db.prepare("INSERT INTO cosmetic_purchases VALUES(?,?,?)").run(
          uid,
          kind,
          mediaId,
        );
      }
      apply();
      return profiles.get(uid).polychrome;
    });
  }
  function approvePost(post) {
    if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(post.authorId))
      return;
    return transaction(() => {
      if (
        !db
          .prepare("INSERT OR IGNORE INTO reviewed_posts VALUES(?,?,?)")
          .run(post.id, post.authorId, new Date().toISOString()).changes
      )
        return;
      const n = db
        .prepare("SELECT count(*) n FROM reviewed_posts WHERE userId=?")
        .get(post.authorId).n;
      if (n % 3 !== 0) return;
      const batch = n / 3,
        amount = Math.min(
          Math.max(0, Math.min(10, Math.floor(roll()))),
          1e12 - profiles.get(post.authorId).polychrome,
        );
      if (
        db
          .prepare("INSERT OR IGNORE INTO premium_rewards VALUES(?,?,?)")
          .run(post.authorId, batch, amount).changes
      )
        ledger(
          post.authorId,
          amount,
          "reviewed_posts",
          "三篇不同委托经管理员审核通过",
        );
    });
  }
  return { purchase, approvePost };
}
