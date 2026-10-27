import { load } from "cheerio";
import { wikiIdentity } from "./identity.mjs";
import { createHash } from "node:crypto";
export const wikiOrigin = "https://zh.moegirl.org.cn";
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
  const box = html.match(
    /<(?:table|aside|div)[^>]*class=["'][^"']*(?:infobox|infotemplate)[^"']*["'][^>]*>([\s\S]*?)<\/(?:table|aside|div)>/i,
  )?.[1];
  for (const tag of (box || html).match(/<img\b[^>]*>/gi) || []) {
    if (
      !box &&
      !/pi-image-thumbnail|infobox|thumbimage|character|萌娘|角色/i.test(tag)
    )
      continue;
    const match =
      tag.match(/data-src=["']([^"']+)["']/i) ||
      tag.match(/src=["']([^"']+)["']/i);
    try {
      const u = new URL((match?.[1] || "").replace(/&amp;/g, "&"));
      if (
        u.protocol === "https:" &&
        /\.(?:png|jpe?g|webp|gif)(?:[!/]|$)/i.test(u.pathname) &&
        [
          "storage.moegirl.org.cn",
          "img.moegirl.org.cn",
          "commons.moegirl.org.cn",
          "zh.moegirl.org.cn",
        ].includes(u.hostname) &&
        !u.username &&
        !u.password
      )
        return u.href;
    } catch {}
  }
  return "";
}
async function textResponse(response, max = 4000000) {
  if (!response.ok) throw fail(`萌娘百科HTTP ${response.status}；未回退旧Wiki`);
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw fail("萌娘百科响应过大");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString();
}
async function request(url, fetcher) {
  for (let n = 0; n < 4; n++) {
    if (url.origin !== wikiOrigin) throw fail("拒绝离开萌娘百科来源");
    const response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
      headers: {
        "User-Agent":
          "InterKnotResidentAI/1.0 (administrator initiated; source attribution preserved)",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) throw fail("萌娘百科重定向缺少地址");
      url = new URL(next, url);
      continue;
    }
    return { text: await textResponse(response), url };
  }
  throw fail("萌娘百科重定向过多");
}
function publicArticle(html, page) {
  const $ = load(html),
    root = $(".mw-parser-output").first().length
      ? $(".mw-parser-output").first()
      : $("#mw-content-text").first();
  if (
    !root.length ||
    root.find(".noarticletext").length ||
    /萌百娘找不到这个页面/.test(root.text().slice(0, 2000))
  )
    throw fail("萌娘百科页面不存在或未返回可读取正文");
  root
    .find(
      "script,style,nav,.navbox,.metadata,.noprint,.mw-editsection,.toc,.catlinks",
    )
    .remove();
  const revision =
    html.match(/"wgRevisionId"\s*:\s*(\d+)/)?.[1] ||
    $('a[href*="oldid="]')
      .first()
      .attr("href")
      ?.match(/oldid=(\d+)/)?.[1];
  return {
    html: root.html() || "",
    title:
      $(".mw-page-title-main").first().text() ||
      $("#firstHeading").first().text() ||
      page,
    revision: revision ? Number(revision) : null,
  };
}
async function article(page, fetcher, publicOnly = false) {
  if (!publicOnly) {
    const u = new URL("/api.php", wikiOrigin);
    u.search = new URLSearchParams({
      action: "parse",
      page,
      prop: "text|revid",
      format: "json",
      redirects: "1",
    }).toString();
    const result = await request(u, fetcher);
    let data;
    try {
      data = JSON.parse(result.text);
    } catch {}
    if (data?.parse?.text?.["*"])
      return {
        html: data.parse.text["*"],
        title: data.parse.title || page,
        revision: data.parse.revid || null,
      };
    // The anonymous API is restricted; read only the already-public article, no
    // cookies, CAPTCHA bypass, credentials or fallback to a different wiki.
  }
  const result = await request(
    new URL("/" + encodeURIComponent(page), wikiOrigin),
    fetcher,
  );
  return publicArticle(result.text, page);
}
export function isCharacterArticle(html) {
  const $ = load(html);
  $("script,style,nav,.navbox,.metadata,.noprint").remove();
  const text = cleanWiki($.html()).slice(0, 20000);
  return /(?:是|为)[^。\n]{0,300}绝区零[^。\n]{0,180}(?:登场角色|登场人物|非玩家角色|NPC|角色之一)/i.test(
    text,
  );
}
export async function fetchWiki(
  role,
  { fetcher = fetch, portraitOnly = false } = {},
) {
  let source;
  try {
    source = await article(role.wiki, fetcher);
  } catch (e) {
    if (e.status) throw e;
    throw fail("萌娘百科读取失败（网络、TLS或源站限制），保留原资料");
  }
  const avatarUrl = wikiPortrait(source.html);
  if (portraitOnly) {
    if (!avatarUrl) throw fail("萌娘百科未提供可识别的角色图，保留原头像");
    return { avatarUrl };
  }
  const $ = load(source.html);
  $(
    "script,style,nav,.navbox,.metadata,.noprint,.toc,.mw-editsection",
  ).remove();
  const text = cleanWiki($.html());
  if (text.length < 800) throw fail("萌娘百科正文不足800字，未生成提示词");
  return {
    text: text.slice(0, 90000),
    avatarUrl,
    sources: [
      {
        url: wikiOrigin + "/" + encodeURIComponent(source.title),
        revision: source.revision,
        licenseUrl: wikiOrigin + "/萌娘百科:版权信息",
        fetchedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(text).digest("hex"),
        verification: "server-fetched",
      },
    ],
  };
}
export async function discoverWikiCharacters({ fetcher = fetch } = {}) {
  const candidates = new Set();
  let continuation = "",
    publicOnly = false,
    truncated = false;
  for (let i = 0; i < 20; i++) {
    const u = new URL("/api.php", wikiOrigin);
    u.search = new URLSearchParams({
      action: "query",
      list: "categorymembers",
      cmtitle: "Category:绝区零",
      cmnamespace: "0",
      cmtype: "page",
      cmlimit: "100",
      format: "json",
      ...(continuation ? { cmcontinue: continuation } : {}),
    }).toString();
    const { text } = await request(u, fetcher);
    let d;
    try {
      d = JSON.parse(text);
    } catch {}
    if (!Array.isArray(d?.query?.categorymembers)) {
      publicOnly = true;
      break;
    }
    for (const item of d.query.categorymembers)
      if (item.ns === 0 && typeof item.title === "string")
        candidates.add(item.title);
    continuation = d.continue?.cmcontinue || "";
    if (!continuation) break;
    if (i === 19) truncated = true;
  }
  if (publicOnly) {
    let u = new URL("/Category:绝区零", wikiOrigin);
    for (let i = 0; i < 20; i++) {
      const { text } = await request(u, fetcher),
        $ = load(text),
        root = $("#mw-pages");
      if (!root.length)
        throw fail("萌娘百科分类公开页面结构不可识别，未导入杂项");
      root.find(".mw-category-group a,.mw-category a").each((_, a) => {
        const title = $(a).attr("title") || $(a).text();
        if (title) candidates.add(title);
      });
      const next = root
        .find("a")
        .filter((_, a) => /下一页/.test($(a).text()))
        .first()
        .attr("href");
      if (!next) break;
      u = new URL(next, wikiOrigin);
      if (u.origin !== wikiOrigin) throw fail("分类分页来源无效");
      if (i === 19) truncated = true;
    }
  }
  const found = new Map(),
    failures = [];
  for (const title of candidates) {
    if (
      title.length > 120 ||
      /[\/#?\\]/.test(title) ||
      /^(?:Category|分类|File|Template|User|模板|用户):/.test(title) ||
      /邦布|Bangboo/i.test(title)
    )
      continue;
    let page;
    try {
      page = await article(title, fetcher, publicOnly);
    } catch (e) {
      failures.push({ wiki: title, error: e.status ? e.message : "读取失败" });
      continue;
    }
    if (!isCharacterArticle(page.html)) continue;
    const key = wikiIdentity(page.title);
    if (!found.has(key))
      found.set(key, {
        wiki: page.title,
        name: page.title.replace(/\(绝区零\)$/, ""),
        kind: /NPC|非玩家角色/.test(cleanWiki(page.html).slice(0, 2000))
          ? "resident"
          : "agent",
      });
  }
  if (!found.size)
    throw fail("萌娘百科未返回通过角色正文校验的条目，未导入组织/音乐/道具");
  return {
    items: [...found.values()],
    truncated: truncated || failures.length > 0,
    failures,
    examined: candidates.size,
  };
}
