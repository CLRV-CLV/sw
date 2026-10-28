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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const BLOCKED =
  /just a moment|cf-chl|cf-error|访问验证|安全验证|请完成验证|人机验证/i;
const pageCache = new WeakMap(),
  requestClock = new WeakMap(),
  apiGate = new WeakMap();
const attempts = () => {
  const n = Number(process.env.AI_WIKI_ATTEMPTS);
  return Number.isSafeInteger(n) && n > 0 && n <= 10 ? n : 4;
};
const minInterval = () => {
  const n = Number(process.env.AI_WIKI_MIN_INTERVAL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 900;
};
const isRealFetch = (fetcher) => fetcher === globalThis.fetch;
const cacheFor = (fetcher) => {
  if (!pageCache.has(fetcher)) pageCache.set(fetcher, new Map());
  return pageCache.get(fetcher);
};
const blocked = (body) =>
  BLOCKED.test(String(body).slice(0, 3000)) &&
  !/mw-parser-output|mw-page-title-main/.test(String(body).slice(0, 20000));
async function pace(fetcher) {
  if (!isRealFetch(fetcher)) return;
  const clock = requestClock.get(fetcher) || { at: 0 };
  const wait = clock.at + minInterval() - Date.now();
  if (wait > 0) await sleep(wait);
  clock.at = Date.now();
  requestClock.set(fetcher, clock);
}
async function readBody(response, max) {
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw Object.assign(new Error("萌娘百科响应过大"), { status: 502 });
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString();
}
async function request(url, fetcher, { max = 4000000 } = {}) {
  if (new URL(url).origin !== wikiOrigin)
    throw Object.assign(new Error("拒绝离开萌娘百科来源"), { status: 502 });
  const limit = attempts();
  let last = "";
  for (let attempt = 0; attempt < limit; attempt++) {
    if (attempt)
      await sleep(isRealFetch(fetcher) ? Math.min(15000, 1500 * 2 ** (attempt - 1)) : 0);
    await pace(fetcher);
    let response;
    try {
      response = await fetcher(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
        headers: {
          // Public CC BY-NC-SA pages are read at <1 request/second with
          // retries; a normal browser identification avoids bot gates that
          // reject unknown clients outright.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.4",
          Referer: wikiOrigin + "/",
        },
      });
    } catch (e) {
      last = `网络连接失败（${e?.name === "TimeoutError" ? "请求超时" : e?.cause?.code || e?.code || "网络错误"}）`;
      continue;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      await response.body?.cancel?.().catch(() => {});
      if (!next)
        throw Object.assign(new Error("萌娘百科重定向缺少地址"), {
          status: 502,
        });
      url = new URL(next, url);
      if (url.origin !== wikiOrigin)
        throw Object.assign(new Error("萌娘百科重定向到非受信站点"), {
          status: 502,
        });
      attempt--;
      continue;
    }
    if (!response.ok) {
      last = `HTTP ${response.status}`;
      await response.body?.cancel?.().catch(() => {});
      if (RETRY_STATUS.has(response.status)) continue;
      throw Object.assign(
        new Error(`萌娘百科HTTP ${response.status}；未回退旧Wiki`),
        { status: 502, wikiHttpStatus: response.status },
      );
    }
    const text = await readBody(response, max);
    if (blocked(text)) {
      last = "源站返回访问验证页";
      continue;
    }
    return { text, url };
  }
  throw Object.assign(
    new Error(
      `萌娘百科读取失败（${last}，已按间隔重试${limit}次）：请稍后重试；源站可能触发风控或限制匿名访问`,
    ),
    { status: 502, retryable: true },
  );
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
    throw Object.assign(new Error("萌娘百科页面不存在或未返回可读取正文"), {
      status: 502,
    });
  const revision =
    html.match(/"wgRevisionId"\s*:\s*(\d+)/)?.[1] ||
    $('a[href*="oldid="]')
      .first()
      .attr("href")
      ?.match(/oldid=(\d+)/)?.[1];
  const title =
    $(".mw-page-title-main").first().text().trim() ||
    $("#firstHeading").first().text().trim() ||
    page;
  root
    .find(
      "script,style,nav,.navbox,.metadata,.noprint,.mw-editsection,.toc,.catlinks",
    )
    .remove();
  return {
    html: root.html() || "",
    title,
    revision: revision ? Number(revision) : null,
  };
}
const articleUrl = (page) => {
  const url = new URL("/", wikiOrigin);
  // Keep the namespace colon literal, like canonical MediaWiki URLs.
  url.pathname = (
    "/" + page.split("/").map(encodeURIComponent).join("/")
  ).replace(/%3A/gi, ":");
  return url;
};
async function getArticle(page, fetcher) {
  const cache = cacheFor(fetcher),
    hit = cache.get(page);
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.value;
  // Anonymous parse API is usually denied on Moegirl. Once it is, skip it for
  // a while instead of spending a rate-limited request on every article.
  const gate = apiGate.get(fetcher) || { until: 0, note: "" };
  let apiError = "";
  const api = new URL("/api.php", wikiOrigin);
  api.search = new URLSearchParams({
    action: "parse",
    page,
    prop: "text|revid",
    format: "json",
    redirects: "1",
  }).toString();
  if (gate.until > Date.now()) apiError = gate.note || "API不可用";
  else
    try {
      const result = await request(api, fetcher);
      let data;
      try {
        data = JSON.parse(result.text);
      } catch {}
      if (data?.parse?.text?.["*"]) {
        apiGate.delete(fetcher);
        const value = {
          html: data.parse.text["*"],
          title: data.parse.title || page,
          revision: data.parse.revid || null,
        };
        cache.set(page, { at: Date.now(), value });
        return value;
      }
      apiError = data?.error?.code || "API未返回正文";
    } catch (e) {
      apiError = e.wikiHttpStatus
        ? `HTTP ${e.wikiHttpStatus}`
        : e.message || "API不可用";
    }
  if (apiError)
    apiGate.set(fetcher, {
      until: Date.now() + 30 * 60000,
      note: apiError,
    });
  // Moegirl restricts anonymous API actions; read the public article instead.
  // No cookies, logins, CAPTCHA bypass or fallback to a different wiki.
  const result = await request(articleUrl(page), fetcher);
  const value = { ...publicArticle(result.text, page), via: "public-page" };
  if (apiError) value.apiNote = apiError;
  cache.set(page, { at: Date.now(), value });
  return value;
}
export function isCharacterArticle(html) {
  const $ = load(html);
  $("script,style,nav,.navbox,.metadata,.noprint").remove();
  const text = cleanWiki($.html());
  const head = text.slice(0, 2500);
  if (
    /(?:是|为)[^。\n]{0,300}绝区零[^。\n]{0,180}(?:登场角色|登场人物|非玩家角色|NPC|角色之一)/i.test(
      text.slice(0, 20000),
    )
  )
    return true;
  const info = $(".infobox,.infotemplate").first();
  if (
    info.length &&
    /绝区零/.test(head) &&
    /(本名|外文名|性别|配音|萌点)/.test(info.text()) &&
    !/^(?:组织|阵营|公司|财团|团体|队伍|机构|协会|家族|组合|乐队|歌曲|专辑|音擎|驱动盘|道具|地图|任务)/.test(
      head.replace(/^[^\p{L}]+/u, ""),
    )
  )
    return true;
  return false;
}
const baseTitle = (title) =>
  String(title)
    .replace(/\((?:绝区零|ZZZ|游戏)\)\s*$/i, "")
    .trim();
export async function fetchWiki(
  role,
  { fetcher = fetch, portraitOnly = false } = {},
) {
  let source;
  try {
    source = await getArticle(role.wiki, fetcher);
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(
      new Error("萌娘百科读取失败（网络、TLS或源站限制），保留原资料"),
      { status: 502 },
    );
  }
  const avatarUrl = wikiPortrait(source.html);
  if (portraitOnly) {
    if (!avatarUrl)
      throw Object.assign(
        new Error("萌娘百科未提供可识别的角色图，保留原头像"),
        { status: 502 },
      );
    return { avatarUrl };
  }
  const $ = load(source.html);
  $(
    "script,style,nav,.navbox,.metadata,.noprint,.toc,.mw-editsection",
  ).remove();
  const text = cleanWiki($.html());
  if (text.length < 800)
    throw Object.assign(new Error("萌娘百科正文不足800字，未生成提示词"), {
      status: 502,
    });
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
        access: source.via === "public-page" ? "anonymous-public-page" : "api",
      },
    ],
  };
}
async function categoryCandidates(add, fetcher) {
  let continuation = "";
  for (let page = 0; page < 20; page++) {
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
      const error = new Error("分类API不可用");
      error.publicOnly = true;
      throw error;
    }
    for (const item of d.query.categorymembers)
      if (item.ns === 0 && typeof item.title === "string") add(item.title);
    continuation = d.continue?.cmcontinue || "";
    if (!continuation) return false;
    if (page === 19) return true;
  }
  return false;
}
async function publicCategoryCandidates(add, fetcher) {
  let u = new URL("/Category:绝区零", wikiOrigin),
    truncated = false;
  for (let page = 0; page < 20; page++) {
    if (u.origin !== wikiOrigin)
      throw Object.assign(new Error("分类分页来源无效"), { status: 502 });
    const { text } = await request(u, fetcher),
      $ = load(text),
      root = $("#mw-pages");
    if (!root.length)
      throw Object.assign(
        new Error("萌娘百科分类公开页面结构不可识别，未导入杂项"),
        { status: 502 },
      );
    root.find(".mw-category-group a,.mw-category a").each((_, a) => {
      const title = $(a).attr("title") || $(a).text();
      if (title) add(title);
    });
    const next = root
      .find("a")
      .filter((_, a) => /下一页/.test($(a).text()))
      .first()
      .attr("href");
    if (!next) return truncated;
    u = new URL(next, wikiOrigin);
    if (page === 19) truncated = true;
  }
  return truncated;
}
function navboxCandidates(html, add) {
  const $ = load(html),
    tables = $("table.navbox, .navbox table");
  let rows = 0,
    links = 0;
  const scanAnchors = (scope) => {
    scope.find("a[title]").each((_, a) => {
      const title = $(a).attr("title");
      if (title && add(title)) links++;
    });
  };
  const scanRows = (root) =>
    root.each((_, tr) => {
      const cells = $(tr).children("td,th");
      if (cells.length < 2) return;
      rows++;
      // First cell is the faction/organisation; character links follow.
      cells.slice(1).each((_, cell) => scanAnchors($(cell)));
    });
  if (tables.length) tables.each((_, table) => scanRows($(table).find("tr")));
  else scanRows($("tr"));
  if (!links) {
    // Skin/layout may differ: fall back to anchors inside navbox-like blocks,
    // then to the whole content area. Per-page character validation still
    // rejects organisations, music and props.
    const scope = $('[class*="navbox"]').length
      ? $('[class*="navbox"]')
      : $(".mw-parser-output").length
        ? $(".mw-parser-output")
        : $("#mw-content-text");
    if (scope.length) scanAnchors(scope);
  }
  return { rows, links };
}
export async function discoverWikiCharacters({ fetcher = fetch } = {}) {
  const candidates = new Map(),
    diagnostics = {
      categoryOk: false,
      categoryApi: false,
      navboxOk: false,
      categoryPages: 0,
      navboxRows: 0,
      pageFailures: 0,
      skippedNonCharacter: 0,
      truncated: false,
      stoppedEarly: false,
    };
  const add = (raw) => {
    const title = String(raw || "").trim();
    if (
      !title ||
      title.length > 120 ||
      /[\/#?\\]/.test(title) ||
      /^(?:Category|分类|File|Template|User|Module|Help|Talk|模板|用户|模块|帮助|讨论):/.test(
        title,
      ) ||
      /邦布|Bangboo/i.test(title)
    )
      return;
    const key = baseTitle(title),
      before = candidates.get(key);
    if (!before || title.length < before.length) candidates.set(key, title);
    return true;
  };
  try {
    diagnostics.truncated =
      (await categoryCandidates(add, fetcher)) || diagnostics.truncated;
    diagnostics.categoryOk = diagnostics.categoryApi = true;
  } catch {
    try {
      diagnostics.truncated =
        (await publicCategoryCandidates(add, fetcher)) || diagnostics.truncated;
      diagnostics.categoryOk = true;
    } catch (e) {
      diagnostics.categoryError = e.message;
    }
  }
  diagnostics.categoryPages = candidates.size;
  let html = "";
  try {
    const { text } = await request(articleUrl("Template:绝区零"), fetcher, {
      max: 5000000,
    });
    html = text;
  } catch (e) {
    diagnostics.navboxError = e.message;
  }
  if (html) {
    const navbox = navboxCandidates(html, add);
    diagnostics.navboxRows = navbox.rows;
    diagnostics.navboxLinks = navbox.links;
    diagnostics.navboxOk = navbox.links > 0;
  }
  if (!diagnostics.categoryOk && !diagnostics.navboxOk)
    throw Object.assign(
      new Error(
        "萌娘百科目录与角色模板均无法读取，未导入任何角色；请检查服务器出站与源站风控",
      ),
      { status: 502 },
    );
  const CAP = 400;
  let entries = [...candidates.entries()];
  if (entries.length > CAP) {
    entries = entries.slice(0, CAP);
    diagnostics.truncated = true;
  }
  const found = new Map(),
    failures = [];
  let consecutive = 0;
  for (const [, title] of entries) {
    try {
      const page = await getArticle(title, fetcher);
      consecutive = 0;
      if (!isCharacterArticle(page.html)) {
        diagnostics.skippedNonCharacter++;
        continue;
      }
      const key = baseTitle(page.title);
      if (!found.has(key)) {
        const text = cleanWiki(page.html).slice(0, 2500);
        found.set(key, {
          wiki: page.title,
          name: page.title.replace(/\((?:绝区零|ZZZ)\)\s*$/i, "").trim(),
          kind: /NPC|非玩家角色/.test(text) ? "resident" : "agent",
        });
      }
    } catch (e) {
      diagnostics.pageFailures++;
      consecutive++;
      if (failures.length < 40)
        failures.push({ wiki: title, error: e.message || "读取失败" });
      if (
        consecutive >= 6 &&
        /403|风控|重试|访问验证|读取失败/.test(e.message || "")
      ) {
        diagnostics.stoppedEarly = true;
        break;
      }
    }
  }
  if (!found.size)
    throw Object.assign(
      new Error("萌娘百科未返回通过角色正文校验的条目，未导入组织/音乐/道具"),
      { status: 502 },
    );
  return {
    items: [...found.values()],
    truncated: diagnostics.truncated,
    stoppedEarly: diagnostics.stoppedEarly,
    complete:
      !diagnostics.truncated &&
      !diagnostics.stoppedEarly &&
      diagnostics.pageFailures === 0 &&
      (diagnostics.categoryOk || diagnostics.navboxOk),
    examined: entries.length,
    validated: found.size,
    pageFailures: diagnostics.pageFailures,
    skippedNonCharacter: diagnostics.skippedNonCharacter,
    diagnostics,
    failures,
  };
}
