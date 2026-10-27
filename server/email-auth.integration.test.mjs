import { test } from "node:test";
import assert from "node:assert/strict";
import { createSmtpSink } from "./test-helpers/smtp.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real SMTP + HTTP: email registration, single-use login, bind, reset, sessions and restart", async () => {
  const { server: smtp, messages } = await createSmtpSink();
  const dir = mkdtempSync(join(tmpdir(), "sw-email-http-")),
    base = "http://127.0.0.1:39149";
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["index.mjs"], {
      cwd: new URL(".", import.meta.url),
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: "39149",
        SEED_DEMO: "0",
        SECURE_COOKIE: "0",
        AUTO_FIRST_ADMIN: "1",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.address().port),
        SMTP_SECURE: "0",
        SMTP_ALLOW_INSECURE: "1",
        SMTP_FROM: "noreply@example.test",
        SMTP_USER: "",
        SMTP_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(base + "/health")).ok) return;
      } catch {}
      if (child.exitCode !== null) throw Error(log);
      await new Promise((r) => setTimeout(r, 40));
    }
    throw Error("startup timeout " + log);
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
  };
  const call = async (path, method = "GET", data, token) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie"),
    };
  };
  const send = async (email, purpose) => {
    const r = await call("/v1/auth/email-codes", "POST", { email, purpose });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.cooldownSecs, 60);
    return messages.at(-1)?.code;
  };
  try {
    await start();
    assert.equal((await call("/v1/capabilities")).data.emailVerification, true);
    const email = "alice@example.test",
      password = "original-password-123",
      code = await send(email, "register");
    assert.match(code, /^\d{6}$/);
    assert.equal(
      (await call("/v1/auth/login/email-code", "POST", { email, code })).status,
      400,
    );
    const account = await call("/v1/auth/register", "POST", {
      email,
      code,
      password,
    });
    assert.equal(account.status, 201);
    assert.match(account.cookie, /HttpOnly/);
    assert.ok(!JSON.stringify(account.data).includes(email + "\n"));
    const token = account.data.token;
    assert.equal(
      (await call("/v1/admin/overview", "GET", undefined, token)).status,
      200,
    );
    assert.equal(
      (await call("/v1/me/security", "GET", undefined, token)).data.email,
      email,
    );
    assert.equal(
      (await call("/v1/auth/register", "POST", { email, code, password }))
        .status,
      400,
    );
    const loginCode = await send(email, "login");
    assert.equal(
      (await call("/v1/auth/email-codes", "POST", { email, purpose: "login" }))
        .status,
      429,
    );
    const login = await call("/v1/auth/login/email-code", "POST", {
      email,
      code: loginCode,
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.id, account.data.user.id);
    assert.equal(
      (
        await call("/v1/auth/login/email-code", "POST", {
          email,
          code: loginCode,
        })
      ).status,
      400,
    );
    const count = messages.length;
    assert.equal(
      (
        await call("/v1/auth/email-codes", "POST", {
          email: "unknown@example.test",
          purpose: "login",
        })
      ).status,
      200,
    );
    assert.equal(messages.length, count);
    await call("/v1/auth/register", "POST", { username: "Bob", password });
    const bob = await call("/v1/auth/login", "POST", {
        username: "Bob",
        password,
      }),
      bt = bob.data.token;
    const bound = "bob@example.test";
    assert.equal(
      (await call("/v1/me/email/code", "POST", { email: bound }, bt)).status,
      200,
    );
    const bindCode = messages.at(-1).code;
    assert.equal(
      (
        await call(
          "/v1/me/email",
          "PUT",
          { email: bound, code: bindCode },
          token,
        )
      ).status,
      409,
    );
    await stop();
    await start();
    assert.equal(
      (await call("/v1/me/email", "PUT", { email: bound, code: bindCode }, bt))
        .status,
      200,
    );
    assert.equal(
      (await call("/v1/auth/login", "POST", { identifier: bound, password }))
        .data.user.id,
      bob.data.user.id,
    );
    assert.equal(
      (
        await call(
          "/v1/me/email/code",
          "POST",
          { email: "other@example.test" },
          bt,
        )
      ).status,
      409,
    );
    const resetCode = await send(email, "reset_password");
    const reset = await call("/v1/auth/password/reset", "POST", {
      email,
      code: resetCode,
      newPassword: "updated-password-456",
    });
    assert.equal(reset.status, 200);
    assert.equal((await call("/v1/me", "GET", undefined, token)).status, 401);
    assert.equal(
      (await call("/v1/me", "GET", undefined, login.data.token)).status,
      401,
    );
    assert.equal(
      (await call("/v1/auth/login", "POST", { identifier: email, password }))
        .status,
      401,
    );
    assert.equal(
      (
        await call("/v1/auth/login", "POST", {
          identifier: email,
          password: "updated-password-456",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/v1/auth/password/reset", "POST", {
          email,
          code: resetCode,
          newPassword: "replayed-password-789",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/v1/auth/email-codes", "POST", {
          email: "a\r\nBCC: b@example.test",
          purpose: "login",
        })
      ).status,
      400,
    );
  } finally {
    await stop();
    await new Promise((r) => smtp.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
