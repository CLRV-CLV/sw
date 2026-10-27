import nodemailer from "nodemailer";
import {
  createHmac,
  randomInt,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const fail = (status, message) => Object.assign(new Error(message), { status });
export function normalizeEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^\S+@[^\s@]+\.[^\s@]+$/.test(value) ||
    /[<>(),;:\\"\r\n]/.test(value)
  )
    throw fail(400, "邮箱格式无效");
  return value.trim().toLowerCase();
}
export function createSmtpMailer(env = process.env) {
  const configured = !!(env.SMTP_HOST && env.SMTP_FROM);
  if (!configured)
    return {
      configured: false,
      send: async () => {
        throw fail(503, "邮件服务尚未配置，请使用用户名密码登录");
      },
    };
  const invalid = () => ({
    configured: false,
    send: async () => {
      throw fail(503, "邮件服务配置无效，请联系管理员或使用用户名密码登录");
    },
  });
  try {
    normalizeEmail(env.SMTP_FROM);
  } catch {
    return invalid();
  }
  const port = Number(env.SMTP_PORT || 465),
    secure = env.SMTP_SECURE !== "0";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    /[\r\n]/.test(env.SMTP_HOST)
  )
    return invalid();
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure && env.SMTP_ALLOW_INSECURE !== "1",
    ignoreTLS: !secure && env.SMTP_ALLOW_INSECURE === "1",
    auth: env.SMTP_USER
      ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD || "" }
      : undefined,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    configured: true,
    async send(email, code, purpose) {
      await transport.sendMail({
        from: env.SMTP_FROM,
        to: email,
        subject: "绳网账户验证码",
        text: `你的绳网验证码是：${code}\n用途：${{ register: "注册", login: "登录", reset_password: "重置密码", bind: "绑定邮箱" }[purpose]}。10分钟内有效，请勿向任何人透露。如非本人操作，请忽略此邮件。`,
      });
    },
  };
}
export function createEmailAuth(
  db,
  {
    admin,
    profiles,
    dataDir,
    issueSession,
    mailer = createSmtpMailer(),
    now = Date.now,
    key,
  } = {},
) {
  if (!key) {
    const path = join(dataDir, ".email-code-key");
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    key = readFileSync(path);
  }
  if (key.length < 32) throw Error("Invalid email code key");
  db.exec(`CREATE TABLE IF NOT EXISTS account_emails(userId TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL);
 CREATE TABLE IF NOT EXISTS email_codes(scope TEXT PRIMARY KEY,email TEXT,purpose TEXT,ownerId TEXT,digest TEXT,expires INTEGER,attempts INTEGER,sentAt INTEGER);
 CREATE TABLE IF NOT EXISTS email_code_limits(key TEXT PRIMARY KEY,count INTEGER,expires INTEGER);`);
  const digest = (s) => createHmac("sha256", key).update(s).digest("hex");
  const scope = (email, purpose, owner = "") =>
    digest(JSON.stringify([email, purpose, owner]));
  const ownerOf = (email) =>
    db
      .prepare(
        "SELECT u.* FROM account_emails e JOIN users u ON u.id=e.userId WHERE e.email=?",
      )
      .get(email);
  const emailOf = (id) =>
    db.prepare("SELECT email FROM account_emails WHERE userId=?").get(id)
      ?.email || null;
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const checkPassword = (p) => {
    if (typeof p !== "string" || p.length < 10 || p.length > 200)
      throw fail(400, "密码需10–200字符");
  };
  function verify(email, purpose, code, owner = "") {
    if (typeof code !== "string" || !/^\d{6}$/.test(code))
      throw fail(400, "验证码无效或已过期");
    const id = scope(email, purpose, owner),
      r = db.prepare("SELECT * FROM email_codes WHERE scope=?").get(id);
    if (!r || r.expires <= now() || r.attempts >= 5)
      throw fail(400, "验证码无效或已过期");
    db.prepare("UPDATE email_codes SET attempts=attempts+1 WHERE scope=?").run(
      id,
    );
    if (
      !timingSafeEqual(
        Buffer.from(r.digest, "hex"),
        Buffer.from(digest(id + ":" + code), "hex"),
      )
    )
      throw fail(400, "验证码无效或已过期");
    return id;
  }
  const consume = (id) => {
    if (!db.prepare("DELETE FROM email_codes WHERE scope=?").run(id).changes)
      throw fail(400, "验证码已使用");
  };
  async function send(email, purpose, req, owner = "") {
    if (!mailer.configured)
      throw fail(503, "邮件服务尚未配置，请使用用户名密码登录");
    const id = scope(email, purpose, owner),
      code = String(randomInt(0, 1000000)).padStart(6, "0"),
      at = now();
    transaction(() => {
      db.prepare("DELETE FROM email_code_limits WHERE expires<=?").run(at);
      db.prepare("DELETE FROM email_codes WHERE expires<=? AND sentAt<?").run(
        at,
        at - 60000,
      );
      const r = db
        .prepare("SELECT sentAt FROM email_codes WHERE scope=?")
        .get(id);
      if (r && at - r.sentAt < 60000) throw fail(429, "请稍后再发送验证码");
      for (const [k, max] of [
        [digest("mail:" + email), 10],
        [digest("ip:" + (req.socket?.remoteAddress || "unknown")), 30],
      ]) {
        const limit = db
          .prepare("SELECT count FROM email_code_limits WHERE key=?")
          .get(k);
        if ((limit?.count || 0) >= max)
          throw fail(429, "验证码请求过多，请稍后重试");
        db.prepare(
          "INSERT INTO email_code_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        ).run(k, at + 3600000);
      }
      db.prepare(
        "INSERT OR REPLACE INTO email_codes VALUES(?,?,?,?,?,?,0,?)",
      ).run(
        id,
        email,
        purpose,
        owner,
        digest(id + ":" + code),
        at + 600000,
        at,
      );
    });
    // Identical public acknowledgement for unregistered/already registered addresses.
    const target = ownerOf(email);
    const deliver =
      purpose === "bind" ||
      (purpose === "register" ? !target : !!target && !admin.banned(target));
    if (deliver)
      try {
        await mailer.send(email, code, purpose);
      } catch {
        db.prepare(
          "UPDATE email_codes SET expires=0 WHERE scope=? AND digest=?",
        ).run(id, digest(id + ":" + code));
        throw fail(503, "邮件发送失败，请稍后重试或联系管理员");
      }
    return { sent: true, expiresInSecs: 600, cooldownSecs: 60 };
  }
  function register(b) {
    const email = normalizeEmail(b.email);
    checkPassword(b.password);
    if (!admin.settings().registrationOpen) throw fail(403, "注册暂时关闭");
    const codeId = verify(email, "register", b.code);
    if (ownerOf(email)) throw fail(400, "无法使用此邮箱注册");
    const id = randomUUID(),
      username = "mail_" + randomBytes(12).toString("hex"),
      salt = randomBytes(16).toString("hex"),
      hash = scryptSync(b.password, salt, 64).toString("hex");
    transaction(() => {
      consume(codeId);
      const first =
        !db
          .prepare("SELECT 1 FROM app_meta WHERE key='admin_bootstrapped'")
          .get() && db.prepare("SELECT count(*) n FROM users").get().n === 0;
      db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
        id,
        username,
        hash,
        salt,
      );
      db.prepare("INSERT INTO account_emails VALUES(?,?)").run(id, email);
      if (first && process.env.AUTO_FIRST_ADMIN !== "0") {
        db.prepare("INSERT INTO user_access VALUES(?,'admin',0)").run(id);
        db.prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?)").run(
          randomUUID(),
          id,
          "admin.bootstrap",
          id,
          new Date(now()).toISOString(),
        );
      }
      db.prepare(
        "INSERT OR IGNORE INTO app_meta VALUES('admin_bootstrapped','1')",
      ).run();
      profiles.set(id, { nickname: "绳匠" });
    });
    return db.prepare("SELECT * FROM users WHERE id=?").get(id);
  }
  async function handler({ path, req, res, auth, body, reply }) {
    if (path === "/v1/me/security" && req.method === "GET") {
      const u = auth();
      reply({
        hasPassword: !!u.password,
        email: emailOf(u.id),
        mihoyoBound: false,
      });
      return true;
    }
    if (path === "/v1/auth/email-codes" && req.method === "POST") {
      const b = await body(req),
        email = normalizeEmail(b.email);
      if (!["register", "login", "reset_password"].includes(b.purpose))
        throw fail(400, "无效验证码用途");
      if (b.purpose === "register" && !admin.settings().registrationOpen)
        throw fail(403, "注册暂时关闭");
      reply(await send(email, b.purpose, req));
      return true;
    }
    if (path === "/v1/me/email/code" && req.method === "POST") {
      const u = auth(),
        b = await body(req),
        email = normalizeEmail(b.email),
        old = emailOf(u.id);
      if (old && old !== email) throw fail(409, "已绑定邮箱暂不支持直接换绑");
      reply(await send(email, "bind", req, u.id));
      return true;
    }
    if (path === "/v1/me/email" && req.method === "PUT") {
      const u = auth(),
        b = await body(req),
        email = normalizeEmail(b.email),
        old = emailOf(u.id),
        target = ownerOf(email);
      if ((old && old !== email) || (target && target.id !== u.id))
        throw fail(409, "无法绑定此邮箱");
      const id = verify(email, "bind", b.code, u.id);
      transaction(() => {
        consume(id);
        db.prepare("INSERT OR REPLACE INTO account_emails VALUES(?,?)").run(
          u.id,
          email,
        );
      });
      reply({ ok: true });
      return true;
    }
    if (path === "/v1/auth/login/email-code" && req.method === "POST") {
      const b = await body(req),
        email = normalizeEmail(b.email),
        id = verify(email, "login", b.code),
        u = ownerOf(email);
      if (!u || admin.banned(u)) throw fail(400, "验证码无效或账号不可用");
      transaction(() => consume(id));
      reply(issueSession(u, req, res));
      return true;
    }
    if (path === "/v1/auth/password/reset" && req.method === "POST") {
      const b = await body(req),
        email = normalizeEmail(b.email);
      checkPassword(b.newPassword);
      const id = verify(email, "reset_password", b.code),
        u = ownerOf(email);
      if (!u || admin.banned(u)) throw fail(400, "验证码无效或账号不可用");
      const salt = randomBytes(16).toString("hex"),
        hash = scryptSync(b.newPassword, salt, 64).toString("hex");
      transaction(() => {
        consume(id);
        db.prepare("UPDATE users SET password=?,salt=? WHERE id=?").run(
          hash,
          salt,
          u.id,
        );
        db.prepare("DELETE FROM sessions WHERE userId=?").run(u.id);
        db.prepare("DELETE FROM email_codes WHERE email=?").run(email);
      });
      res?.setHeader(
        "Set-Cookie",
        "ik_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      reply({ ok: true });
      return true;
    }
    return false;
  }
  return { handler, register, ownerOf, emailOf, configured: mailer.configured };
}
