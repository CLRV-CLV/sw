/** Group full-sync failures by reason so the admin can see what to fix. */
export interface SyncFailure {
  roleId?: string;
  name?: string;
  error?: string;
}
export interface SyncFailureGroup {
  error: string;
  names: string[];
}

export function groupSyncFailures(
  errors: SyncFailure[] | null | undefined,
): SyncFailureGroup[] {
  const grouped = new Map<string, string[]>();
  for (const item of errors || []) {
    const key = String(item?.error || "未知错误").trim() || "未知错误";
    const names = grouped.get(key) || [];
    names.push(item?.name || item?.roleId || "未命名角色");
    grouped.set(key, names);
  }
  return [...grouped]
    .map(([error, names]) => ({ error, names }))
    .sort(
      (a, b) =>
        b.names.length - a.names.length || a.error.localeCompare(b.error),
    );
}

/** A one-line verdict for the last run: what is left and whether it is done. */
export function syncVerdict(
  result:
    | {
        total?: number;
        failed?: number;
        generated?: number;
        stoppedEarly?: boolean;
        complete?: boolean;
        remaining?: unknown[];
      }
    | null
    | undefined,
): { tone: "done" | "partial" | "paused"; text: string } {
  if (!result) return { tone: "partial", text: "尚未运行全角色流水线。" };
  const remaining = Array.isArray(result.remaining)
    ? result.remaining.length
    : 0;
  const failed = Number(result.failed) || 0;
  if (result.stoppedEarly)
    return {
      tone: "paused",
      text: `源站连续拒绝，已自动暂停；剩余 ${remaining} 个未处理，稍后可直接重试。`,
    };
  if (result.complete && !failed)
    return {
      tone: "done",
      text: `全部角色已生成 ${Number(result.generated) || 0} 个，可继续人工审核启用。`,
    };
  return {
    tone: "partial",
    text: `仍有 ${failed} 个角色失败、${remaining} 个未处理；点“只重试未完成角色”即可继续，已生成的不会重复消耗额度。`,
  };
}
