import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAdmin } from "./admin.mjs";
import { createProfiles } from "./site-data.mjs";
import { createEmailAuth, createSmtpMailer } from "./email-auth.mjs";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,password TEXT,salt TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,userId TEXT,expires INTEGER);CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);`,
  );
  const profiles = createProfiles(db),
    admin = createAdmin(db),
    messages = [];
  let time = Date.parse("2026-10-27T00:00:00Z");
  const opts = {
    admin,
    profiles,
    key: Buffer.alloc(32, 7),
    now: () => time,
    issueSession: (u) => ({ user: { id: u.id } }),
    mailer: {
      configured: true,
      async send(email, code, purpose) {
        messages.push({ email, code, purpose });
      },
    },
  };
  const api = createEmailAuth(db, opts),
    req = { method: "POST", socket: { remoteAddress: "127.0.0.1" } };
  const call = async (path, b = {}, user) => {
    let out;
    await api.handler({
      path,
      req: { ...req, method: path === "/v1/me/email" ? "PUT" : "POST" },
      res: { setHeader() {} },
      auth: () => user,
      body: async () => b,
      reply: (r) => (out = r),
    });
    return out;
  };
  return { db, api, call, messages, opts, advance: (n) => (time += n) };
}
test("codes are HMAC-only, purpose-scoped, expire, exhaust attempts and cannot be replayed", async () => {
  const f = fixture();
  try {
    const email = "test@example.test";
    await f.call("/v1/auth/email-codes", { email, purpose: "register" });
    const code = f.messages.at(-1).code;
    const row = f.db.prepare("SELECT * FROM email_codes").get();
    assert.equal(row.digest.length, 64);
    assert.notEqual(row.digest, code);
    assert.ok(!JSON.stringify(row).includes('"' + code + '"'));
    const password = "safe-password-123";
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++)
      assert.throws(() => f.api.register({ email, code: wrong, password }), {
        status: 400,
      });
    assert.throws(() => f.api.register({ email, code, password }), {
      status: 400,
    });
    f.advance(60001);
    await f.call("/v1/auth/email-codes", { email, purpose: "register" });
    const fresh = f.messages.at(-1).code;
    const user = f.api.register({ email, code: fresh, password });
    assert.equal(f.api.emailOf(user.id), email);
    assert.throws(() => f.api.register({ email, code: fresh, password }), {
      status: 400,
    });
    await f.call("/v1/auth/email-codes", { email, purpose: "login" });
    const loginCode = f.messages.at(-1).code;
    f.advance(600001);
    await assert.rejects(
      f.call("/v1/auth/login/email-code", { email, code: loginCode }),
      { status: 400 },
    );
  } finally {
    f.db.close();
  }
});
test("mailer errors are sanitized, never return codes, and respect send cooldown", async () => {
  const f = fixture();
  try {
    const api = createEmailAuth(f.db, {
      ...f.opts,
      mailer: {
        configured: true,
        send: async () => {
          throw Error("SMTP_PASSWORD=private upstream response");
        },
      },
    });
    const call = () =>
      api.handler({
        path: "/v1/auth/email-codes",
        req: { method: "POST", socket: { remoteAddress: "127.0.0.1" } },
        body: async () => ({ email: "fail@example.test", purpose: "register" }),
        reply: () => assert.fail("must not report success"),
      });
    await assert.rejects(
      call(),
      (e) => e.status === 503 && !e.message.includes("private"),
    );
    await assert.rejects(call(), { status: 429 });
    assert.equal(createSmtpMailer({}).configured, false);
    assert.equal(
      createSmtpMailer({ SMTP_HOST: "localhost", SMTP_FROM: "bad address" })
        .configured,
      false,
    );
    assert.equal(
      createSmtpMailer({
        SMTP_HOST: "localhost",
        SMTP_FROM: "test@example.test",
        SMTP_PORT: "-1",
      }).configured,
      false,
    );
    await assert.rejects(createSmtpMailer({}).send(), { status: 503 });
  } finally {
    f.db.close();
  }
});
test("send limits persist in database and do not trust forwarded IP headers", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 30; i++)
      await f.call("/v1/auth/email-codes", {
        email: `user${i}@example.test`,
        purpose: "register",
      });
    await assert.rejects(
      f.call("/v1/auth/email-codes", {
        email: "over@example.test",
        purpose: "register",
      }),
      { status: 429 },
    );
    createEmailAuth(f.db, f.opts);
    await assert.rejects(
      f.call("/v1/auth/email-codes", {
        email: "other@example.test",
        purpose: "register",
      }),
      { status: 429 },
    );
    f.advance(3600001);
    await f.call("/v1/auth/email-codes", {
      email: "over@example.test",
      purpose: "register",
    });
  } finally {
    f.db.close();
  }
});
