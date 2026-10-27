import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const fail = (status, msg) => Object.assign(new Error(msg), { status });
export function createProvider(
  db,
  { env = process.env, dataDir, fetcher = fetch } = {},
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS ai_config(id INTEGER PRIMARY KEY,data TEXT)",
  );
  const stored = () =>
    JSON.parse(
      db.prepare("SELECT data FROM ai_config WHERE id=1").get()?.data || "{}",
    );
  function key() {
    if (env.AI_CONFIG_SECRET)
      return createHash("sha256").update(env.AI_CONFIG_SECRET).digest();
    mkdirSync(dataDir, { recursive: true });
    const p = join(dataDir, ".ai-config-key");
    if (!existsSync(p)) {
      try {
        writeFileSync(p, randomBytes(32), { mode: 0o600, flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    const k = readFileSync(p);
    if (k.length !== 32) throw fail(503, "AI密钥存储不可用");
    return k;
  }
  function seal(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key(), iv);
    const content = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      value: content.toString("base64"),
    };
  }
  function secret(c) {
    if (c.secret) {
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key(),
          Buffer.from(c.secret.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(c.secret.tag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(c.secret.value, "base64")),
          decipher.final(),
        ]).toString();
      } catch {
        throw fail(503, "AI密钥无法解密，请重新配置");
      }
    }
    return env.AI_API_KEY || "";
  }
  function config() {
    const c = stored();
    return {
      enabled: c.enabled ?? env.AI_ENABLED === "1",
      baseUrl: c.baseUrl || env.AI_BASE_URL || "",
      model: c.model || env.AI_MODEL || "",
      secret: c.secret,
    };
  }
  function view() {
    const c = config();
    return {
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      model: c.model,
      hasApiKey: !!(c.secret || env.AI_API_KEY),
    };
  }
  function save(b) {
    if (
      !b ||
      Object.keys(b).some(
        (k) =>
          !["enabled", "baseUrl", "model", "apiKey", "clearApiKey"].includes(k),
      )
    )
      throw fail(400, "无效AI配置");
    const c = { ...stored() };
    if ("enabled" in b) {
      if (typeof b.enabled !== "boolean") throw fail(400, "无效启用状态");
      c.enabled = b.enabled;
    }
    if ("baseUrl" in b) {
      let u;
      try {
        u = new URL(b.baseUrl);
      } catch {
        throw fail(400, "无效New API地址");
      }
      if (
        !(
          u.protocol === "https:" ||
          (u.protocol === "http:" && env.AI_ALLOW_HTTP === "1")
        ) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw fail(400, "New API地址需HTTPS且不能带口令/查询参数");
      c.baseUrl = u.toString().replace(/\/$/, "");
    }
    if ("model" in b) {
      if (
        typeof b.model !== "string" ||
        !b.model.trim() ||
        b.model.length > 120 ||
        /[\r\n]/.test(b.model)
      )
        throw fail(400, "无效模型名称");
      c.model = b.model.trim();
    }
    if ("apiKey" in b) {
      if (
        typeof b.apiKey !== "string" ||
        b.apiKey.length > 512 ||
        /[\r\n]/.test(b.apiKey)
      )
        throw fail(400, "无效API Key");
      if (b.apiKey) c.secret = seal(b.apiKey);
    }
    if ("clearApiKey" in b) {
      if (typeof b.clearApiKey !== "boolean" || (b.clearApiKey && b.apiKey))
        throw fail(400, "无效密钥操作");
      if (b.clearApiKey) {
        if (env.AI_API_KEY) throw fail(400, "环境变量密钥需由部署者清除");
        delete c.secret;
      }
    }
    db.prepare("INSERT OR REPLACE INTO ai_config VALUES(1,?)").run(
      JSON.stringify(c),
    );
    return view();
  }
  async function complete(messages, { maxTokens = 1800, json = true } = {}) {
    const c = config();
    if (!c.enabled || !c.baseUrl || !c.model)
      throw fail(503, "驻站AI尚未配置或未启用");
    const token = secret(c);
    if (!token) throw fail(503, "驻站AI尚未配置密钥");
    let url;
    try {
      url = new URL(c.baseUrl);
    } catch {
      throw fail(503, "AI地址无效");
    }
    if (
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && env.AI_ALLOW_HTTP === "1")
      ) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw fail(503, "AI地址必须为HTTPS");
    const endpoint =
      c.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "") +
      "/v1/chat/completions";
    let response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(60000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: c.model,
          messages,
          stream: false,
          temperature: 0.55,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch {
      throw fail(502, "AI服务连接失败或超时");
    }
    if (!response.ok) {
      response.body?.cancel?.().catch(() => {});
      throw fail(502, `AI服务请求失败（HTTP ${response.status}）`);
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262144) {
          await reader.cancel();
          throw fail(502, "AI响应超出限制");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let raw;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw fail(502, "AI返回格式无效");
    }
    if (raw.choices?.[0]?.finish_reason === "length")
      throw fail(502, "AI输出被截断，请调整模型");
    const output = raw.choices?.[0]?.message?.content;
    if (typeof output !== "string" || !output.trim())
      throw fail(502, "AI未返回文本");
    if (!json) return output;
    try {
      return JSON.parse(output);
    } catch {
      throw fail(502, "AI未返回所需JSON结构");
    }
  }
  return { view, save, complete };
}
