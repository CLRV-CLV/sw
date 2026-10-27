// Inventory, not proof of implementation. Runtime contracts are tested separately.
import { readFileSync, writeFileSync } from "node:fs";
const source = "web/app/composables/useApi.ts";
const text = readFileSync(source, "utf8");
const routes = [
  ...new Set(
    [...text.matchAll(/["'`]((?:\/v1\/)[^"'`\s]+)/g)].map((m) => m[1]),
  ),
].sort();
const entries = routes.map((route) => {
  let status = "implemented-path-needs-method-level-verification",
    note = "路径已接入；不代表此路径所有方法或所有界面动作均已验证。";
  if (
    /^\/v1\/auth\/(email-codes|login\/email-code|password\/reset)/.test(
      route,
    ) ||
    /^\/v1\/me\/(email|delete-account)/.test(route)
  ) {
    status = "not-implemented";
    note =
      "邮箱验证码/密码重置/邮箱绑定/注销验证尚未接通，缺少真实邮件适配器及完整流程；不是仅填配置即可使用。";
  }
  if (/^\/v1\/auth\/mihoyo/.test(route)) {
    status = "not-implemented";
    note =
      "米游社扫码认证适配器未实现，需要合法平台流程和实测；不伪造扫码成功。";
  }
  if (/^\/v1\/exam\//.test(route)) {
    status = "not-enabled";
    note =
      "本站当前不要求入站考试，GET /v1/exam 明确返回 required:false；没有伪造试卷和考试记录。";
  }
  if (route === "/v1/me/mihoyo") {
    status = "capability-status-only";
    note = "只报告当前未配置/未绑定；不表示具备绑定、同步、解绑全流程。";
  }
  if (route === "/v1/videos/resolve") {
    status = "partial";
    note =
      "校验B站官方链接并生成播放器地址，不抓取元数据，不承诺原站播放权限；抖音等平台未实现。";
  }
  return { route, source, status, note };
});
const output = {
  scope: "useApi.ts路径级静态盘点；不覆盖所有旧敲敲调用，也不是端到端测试报告",
  generatedBy: "node scripts/audit-api-contracts.mjs",
  total: entries.length,
  entries,
};
writeFileSync(
  "docs/api-contract-inventory.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      total: entries.length,
      byStatus: entries.reduce(
        (a, e) => ((a[e.status] = (a[e.status] || 0) + 1), a),
        {},
      ),
    },
    null,
    2,
  ),
);
