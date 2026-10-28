import { expect, it } from "vitest";
import { groupSyncFailures, syncVerdict } from "../../app/utils/sync-report";

it("groups full-sync failures by reason with the affected role names", () => {
  const groups = groupSyncFailures([
    { name: "安比·德玛拉", error: "萌娘百科：HTTP 403" },
    { name: "苍角", error: "AI服务：请求超过240秒" },
    { name: "比利·奇德", error: "萌娘百科：HTTP 403" },
    { name: "可琳", error: "  " },
  ]);
  expect(groups.map((g) => [g.error, g.names.length])).toEqual([
    ["萌娘百科：HTTP 403", 2],
    ["AI服务：请求超过240秒", 1],
    ["未知错误", 1],
  ]);
  expect(groups[0].names).toEqual(["安比·德玛拉", "比利·奇德"]);
});

it("explains a paused run and a rerun instead of claiming success", () => {
  expect(syncVerdict(null).text).toContain("尚未运行");
  const paused = syncVerdict({
    total: 20,
    failed: 6,
    generated: 9,
    stoppedEarly: true,
    remaining: [{}, {}, {}],
  });
  expect(paused.tone).toBe("paused");
  expect(paused.text).toContain("剩余 3 个");
  expect(paused.text).not.toContain("全部");
  const partial = syncVerdict({
    total: 12,
    failed: 2,
    generated: 10,
    complete: false,
    remaining: [],
  });
  expect(partial.tone).toBe("partial");
  expect(partial.text).toContain("仍有 2 个角色失败");
  expect(
    syncVerdict({ total: 9, failed: 0, generated: 9, complete: true }).tone,
  ).toBe("done");
});

it("renders the last full-sync report and offers a discovery-free retry", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("node:fs");
  const admin = readFileSync(
    `${process.cwd()}/app/components/ResidentAIAdmin.vue`,
    "utf8",
  );
  expect(admin).toContain("sync-summary");
  expect(admin).toContain("syncFailures");
  expect(admin).toContain("discover: false");
  expect(admin).toContain("只重试未完成角色");
  expect(admin).toContain("已生成自动跳过");
});
