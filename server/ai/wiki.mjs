import { wikiIdentity } from "./identity.mjs";
import { createHash } from "node:crypto";
export const wikiOrigin = "https://zenless-zone-zero.fandom.com";
const fail = (msg) => Object.assign(new Error(msg), { status: 502 });
export function cleanWiki(html) {
  return html
    .replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => {
      const x =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return x > 0 && x <= 0x10ffff ? String.fromCodePoint(x) : "";
    })
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, n) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[n],
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}
export function wikiPortrait(html) {
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    if (!/pi-image-thumbnail/i.test(tag)) continue;
    const match =
      tag.match(/data-src=["']([^"']+)["']/i) ||
      tag.match(/src=["']([^"']+)["']/i);
    try {
      const u = new URL((match?.[1] || "").replace(/&amp;/g, "&"));
      if (
        u.protocol === "https:" &&
        u.hostname === "static.wikia.nocookie.net" &&
        !u.username &&
        !u.password
      )
        return u.href;
    } catch {}
  }
  return "";
}
export async function fetchWiki(
  role,
  { fetcher = fetch, portraitOnly = false } = {},
) {
  const sources = [],
    failures = [];
  let text = "",
    avatarUrl = "";
  for (const [page, budget] of [
    [role.wiki, 12000],
    [`${role.wiki}/Lore`, 36000],
    [`${role.wiki}/Voice-Overs`, 18000],
    [`${role.wiki}/DMs`, 12000],
  ]) {
    if (portraitOnly && page !== role.wiki) continue;
    const url = new URL("/api.php", wikiOrigin);
    url.search = new URLSearchParams({
      action: "parse",
      page,
      prop: "text|revid",
      format: "json",
      redirects: "1",
    }).toString();
    let response;
    try {
      response = await fetcher(url, {
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          "User-Agent":
            "InterKnotResidentAI/1.0 (wiki source import; administrator initiated)",
        },
      });
    } catch (e) {
      const code = e?.cause?.code;
      failures.push(
        e?.name === "TimeoutError"
          ? "请求超时"
          : code === "ENOTFOUND"
            ? "DNS解析失败"
            : "TLS或网络连接失败",
      );
      continue;
    }
    if (!response.ok) {
      failures.push(`HTTP ${response.status}`);
      response.body?.cancel?.().catch(() => {});
      continue;
    }
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2000000) {
          await reader.cancel();
          throw fail("Wiki页面过大");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      continue;
    }
    if (!data.parse?.text?.["*"]) continue;
    if (portraitOnly) {
      const avatarUrl = wikiPortrait(data.parse.text["*"]);
      if (!avatarUrl) throw fail("Wiki主页面未提供可识别角色图，保留原头像");
      return { avatarUrl };
    }
    if (page === role.wiki) avatarUrl = wikiPortrait(data.parse.text["*"]);
    const cleaned = cleanWiki(data.parse.text["*"]);
    if (cleaned.length < 200) continue;
    const hash = createHash("sha256").update(cleaned).digest("hex");
    if (sources.some((s) => s.sha256 === hash)) continue;
    sources.push({
      url: `${wikiOrigin}/wiki/${encodeURIComponent(page).replace(/%2F/g, "/")}`,
      revision: data.parse.revid || null,
      licenseUrl: "https://www.fandom.com/licensing",
      fetchedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(cleaned).digest("hex"),
    });
    text += `\nSOURCE ${page}\n${cleaned.slice(0, budget)}\n`;
  }
  if (!sources.length || text.length < 800)
    throw fail(
      `未能取得足够的Wiki资料（${[...new Set(failures)].join("、") || "页面缺失或正文不足"}）；保留原档案，未启用角色`,
    );
  return { text: text.slice(0, 90000), sources, avatarUrl };
}

// Fixed MediaWiki endpoint and categories only. Never fetch a client-supplied URL.
export async function discoverWikiCharacters({ fetcher = fetch } = {}) {
  const found = new Map();
  let truncated = false;
  // NPCs is a world-object category, not a curated cast list (Bangboo, vendors,
  // incidental residents, etc.). Never bulk-expand it into resident AI roles.
  for (const [category, kind] of [["Agents", "agent"]]) {
    let continuation = "";
    for (let page = 0; page < 6; page++) {
      const url = new URL("/api.php", wikiOrigin);
      url.search = new URLSearchParams({
        action: "query",
        list: "categorymembers",
        cmtitle: `Category:${category}`,
        cmnamespace: "0",
        cmtype: "page",
        cmlimit: "100",
        format: "json",
        ...(continuation ? { cmcontinue: continuation } : {}),
      }).toString();
      let r;
      try {
        r = await fetcher(url, {
          redirect: "error",
          signal: AbortSignal.timeout(25000),
        });
      } catch {
        throw fail("Wiki角色目录抓取失败");
      }
      if (!r.ok) throw fail("Wiki角色目录不可用");
      const reader = r.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1500000) {
            await reader.cancel();
            throw fail("Wiki目录响应过大");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let d;
      try {
        d = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw fail("Wiki目录格式无效");
      }
      if (!Array.isArray(d.query?.categorymembers))
        throw fail("Wiki目录数据无效");
      for (const item of d.query.categorymembers) {
        const title = item.title;
        if (
          item.ns !== 0 ||
          typeof title !== "string" ||
          title.length > 120 ||
          /[\/#?\\]/.test(title) ||
          [
            "Agent",
            "Agents",
            "NPC",
            "NPCs",
            "Protagonist",
            "Character",
            "Characters",
          ].includes(title)
        )
          continue;
        const key = wikiIdentity(title);
        if (!found.has(key)) found.set(key, { wiki: title, name: title, kind });
      }
      continuation = d.continue?.cmcontinue || "";
      if (!continuation) break;
      if (page === 5) truncated = true;
    }
  }
  if (!found.size) throw fail("Wiki未返回角色目录，未修改现有角色");
  return { items: [...found.values()], truncated };
}
