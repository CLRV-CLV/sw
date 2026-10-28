<script setup lang="ts">
import { selectRoleResults } from "~/utils/role-selection";
import { groupSyncFailures, syncVerdict } from "~/utils/sync-report";
interface Role {
  id: string;
  name: string;
  wiki: string;
  kind: string;
  avatarUrl: string;
  avatarSource?: string;
  enabled: boolean;
  approved: boolean;
  sourceStatus: string;
  dossier: Record<string, string> | null;
  sources: {
    url: string;
    fetchedAt: string;
    revision: number | null;
    verification?: string;
  }[];
}
interface Job {
  id: string;
  kind: string;
  roleId: string;
  state: string;
  error?: string;
  progress?: {
    total: number;
    completed: number;
    imported: number;
    generated: number;
    failed: number;
    current: string;
  };
  result?: {
    postId?: string;
    message?: string;
    added?: number;
    removed?: string[];
    catalog?: number;
    total?: number;
    imported?: number;
    generated?: number;
    failed?: number;
    alreadyComplete?: number;
    stoppedEarly?: boolean;
    complete?: boolean;
    remaining?: { roleId: string; name: string }[];
    errors?: { roleId: string; name: string; error: string }[];
    [key: string]: unknown;
  };
}
const config = ref({
    enabled: false,
    baseUrl: "",
    model: "",
    hasApiKey: false,
    jsonMode: true,
  }),
  apiKey = ref(""),
  roles = ref<Role[]>([]),
  jobs = ref<Job[]>([]),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  selected = ref(""),
  command = ref(""),
  articleRole = ref("random"),
  dossierText = ref(""),
  customName = ref(""),
  customWiki = ref("");
const roleSearch = ref(""),
  checkedRoles = ref<string[]>([]);
const filteredRoles = computed(() =>
  roles.value.filter((r) =>
    (r.name + " " + r.wiki)
      .toLowerCase()
      .includes(roleSearch.value.toLowerCase().trim()),
  ),
);
function selectResults(invert = false) {
  checkedRoles.value = selectRoleResults(
    checkedRoles.value,
    filteredRoles.value.map((r) => r.id),
    invert,
  );
}
async function cleanupCatalog() {
  await act(async () => {
    const preview = await $fetch<{
      items: { id: string; name: string; wiki: string }[];
      total: number;
    }>("/v1/admin/ai/catalog-cleanup");
    if (!preview.total) {
      notice.value =
        "没有可安全清理的旧NPC候选。已编辑、导入资料、审核或启用的条目不会自动清理，可手动选择删除。";
      return;
    }
    if (
      !confirm(
        `发现${preview.total}个旧版误导入NPC候选。仅清理从未编辑、未导入资料、未审核、未启用的自动发现项；内置角色、自建角色和已维护资料不动。示例：${preview.items
          .slice(0, 8)
          .map((r) => r.name)
          .join("、")}。确认删除？`,
      )
    )
      return;
    const result = await $fetch<{ removed: string[] }>(
      "/v1/admin/ai/catalog-cleanup",
      { method: "POST", body: { ids: preview.items.map((r) => r.id) } },
    );
    const removed = new Set(result.removed);
    checkedRoles.value = checkedRoles.value.filter((id) => !removed.has(id));
    if (removed.has(selected.value)) selected.value = "";
    notice.value = `已安全清理${result.removed.length}个旧NPC候选，后续自动发现不会重新导入。`;
  });
}
async function batch(action: "delete" | "wiki" | "avatar") {
  if (!checkedRoles.value.length) return;
  if (
    action === "delete" &&
    !confirm(
      `删除选中的${checkedRoles.value.length}个角色？保留历史帖子与聊天，自动发现不会恢复这些条目。`,
    )
  )
    return;
  await act(async () => {
    const ids = [...checkedRoles.value];
    const result = await $fetch<{
      items: { id?: string; roleId?: string }[];
      remaining: string[];
    }>("/v1/admin/ai/roles/batch", {
      method: "POST",
      body: { action, ids, clientId: crypto.randomUUID() },
    });
    if (action === "delete" && ids.includes(selected.value))
      selected.value = "";
    checkedRoles.value = result.remaining;
    notice.value =
      action === "delete"
        ? `已删除${ids.length}个角色`
        : `已为${result.items.length}个角色加入${action === "wiki" ? "Wiki导入" : "头像更新"}任务；剩余${result.remaining.length}个保持选中，可待队列空闲后继续提交。`;
  });
}
const editAvatar = ref("");
const skipForeignNames = ref(false);
const sourceText = ref(""),
  editWiki = ref(""),
  editName = ref("");
const manualText = ref(""),
  manualPart = ref(""),
  manualRevision = ref<number | undefined>();
const connectionJob = ref(""),
  connectionStarted = ref(0),
  pollingError = ref("");
const stateNames: Record<string, string> = {
  cancelled: "已中断",
  queued: "排队中",
  running: "处理中",
  done: "成功",
  failed: "失败",
};
const kindNames: Record<string, string> = {
  "full-sync": "萌娘百科全角色提示词流水线",
  wiki: "萌娘百科导入",
  dossier: "档案生成",
  catalog: "角色发现",
  article: "文章写作",
  connection: "连接测试",
  avatar: "Wiki头像",
};
const connection = computed(() =>
  jobs.value.find((j) => j.id === connectionJob.value),
);
async function testConnection() {
  await act(async () => {
    const j = await $fetch<Job>("/v1/admin/ai/test", {
      method: "POST",
      body: {
        clientId: crypto.randomUUID(),
        skipForeignNames: skipForeignNames.value,
      },
    });
    connectionJob.value = j.id;
    connectionStarted.value = Date.now();
    notice.value = "正在测试已保存配置；测试会实际调用模型并消耗少量额度。";
  });
}
async function removeRole(wikiOnly = false) {
  if (
    !current.value ||
    !confirm(
      wikiOnly
        ? "清空此角色的Wiki原文、来源及档案，并停用角色？"
        : "删除此角色？已有帖子与聊天记录不会抹除；已删除目录项不会在重启/自动发现时重新出现。",
    )
  )
    return;
  await act(async () => {
    await $fetch(
      `/v1/admin/ai/roles/${selected.value}${wikiOnly ? "/wiki" : ""}`,
      { method: "DELETE" },
    );
    if (!wikiOnly) selected.value = "";
    sourceText.value = "";
    dossierText.value = "{}";
    notice.value = wikiOnly ? "Wiki资料已清空，角色已停用" : "角色已删除";
  });
}
async function dedupe() {
  await act(async () => {
    const r = await $fetch<{ removed: string[]; conflicts: string[] }>(
      "/v1/admin/ai/dedupe",
      { method: "POST" },
    );
    notice.value = `已清理${r.removed.length}个未使用重复目录项；${r.conflicts.length}个已启用/有历史的重复项保留，请人工处理。`;
  });
}
let pollTimer: ReturnType<typeof setInterval> | undefined,
  polling = false;
async function pollJobs() {
  if (polling) return;
  polling = true;
  try {
    const [j, r] = await Promise.all([
      $fetch<{ items: Job[] }>("/v1/admin/ai/jobs"),
      $fetch<{ items: Role[] }>("/v1/admin/ai/roles"),
    ]);
    jobs.value = j.items;
    roles.value = r.items;
    const live = new Set(r.items.map((item) => item.id));
    checkedRoles.value = checkedRoles.value.filter((id) => live.has(id));
    pollingError.value = "";
  } catch (e) {
    pollingError.value = detail(e);
  } finally {
    polling = false;
  }
}
async function manualImport() {
  await act(async () => {
    await $fetch(`/v1/admin/ai/roles/${selected.value}/wiki-text`, {
      method: "PUT",
      body: {
        text: manualText.value,
        part: manualPart.value,
        ...(manualRevision.value ? { revision: manualRevision.value } : {}),
      },
    });
    manualText.value = "";
    notice.value =
      "已导入管理员提供的Wiki原文（不是服务器抓取验证），需要生成、核对并审核。";
  });
}
async function source() {
  if (!selected.value) return;
  await act(async () => {
    const r = await $fetch<{ sourceText: string }>(
      `/v1/admin/ai/roles/${selected.value}`,
    );
    sourceText.value = r.sourceText;
  });
}
const current = computed(() =>
  roles.value.find((r) => r.id === selected.value),
);
function detail(e: unknown) {
  return (e as { data?: { detail?: string } }).data?.detail || "AI管理请求失败";
}
let loadRevision = 0;
async function load() {
  const revision = ++loadRevision;
  try {
    const [c, r, j] = await Promise.all([
      $fetch<typeof config.value>("/v1/admin/ai/config"),
      $fetch<{ items: Role[] }>("/v1/admin/ai/roles"),
      $fetch<{ items: Job[] }>("/v1/admin/ai/jobs"),
    ]);
    if (revision !== loadRevision) return;
    config.value = c;
    roles.value = r.items;
    const live = new Set(r.items.map((item) => item.id));
    checkedRoles.value = checkedRoles.value.filter((id) => live.has(id));
    jobs.value = j.items;
  } catch (e) {
    error.value = detail(e);
  }
}
async function act(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  loadRevision++;
  error.value = "";
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = detail(e);
  } finally {
    busy.value = false;
  }
}
async function saveConfig() {
  await act(async () => {
    await $fetch("/v1/admin/ai/config", {
      method: "PATCH",
      body: {
        enabled: config.value.enabled,
        baseUrl: config.value.baseUrl,
        model: config.value.model,
        jsonMode: config.value.jsonMode,
        ...(apiKey.value ? { apiKey: apiKey.value } : {}),
      },
    });
    apiKey.value = "";
    notice.value = "配置已保存，密钥不会回传。";
  });
}
async function task(kind: "wiki" | "dossier") {
  if (!current.value) return;
  await act(async () => {
    await $fetch(`/v1/admin/ai/roles/${selected.value}/${kind}`, {
      method: "POST",
      body: {
        clientId: crypto.randomUUID(),
        skipForeignNames: skipForeignNames.value,
      },
    });
    notice.value = "任务已加入队列，下方会自动刷新进度和成功/失败结果。";
  });
}
async function patch(body: object) {
  await act(async () => {
    await $fetch(`/v1/admin/ai/roles/${selected.value}`, {
      method: "PATCH",
      body,
    });
  });
}
async function saveDossier() {
  try {
    const dossier = JSON.parse(dossierText.value);
    await patch({ dossier });
  } catch {
    error.value = "档案必须是有效JSON";
  }
}
async function avatars() {
  await act(async () => {
    await $fetch("/v1/admin/ai/avatar-sync", {
      method: "POST",
      body: {
        clientId: crypto.randomUUID(),
        skipForeignNames: skipForeignNames.value,
      },
    });
    notice.value = "Wiki头像更新已入队，不会清除档案或覆盖手动头像。";
  });
}
async function refreshAvatar() {
  if (!current.value) return;
  await act(async () => {
    await $fetch(`/v1/admin/ai/roles/${selected.value}/avatar`, {
      method: "POST",
      body: { clientId: crypto.randomUUID() },
    });
  });
}
const lastFullSync = computed(
  () => jobs.value.find((j) => j.kind === "full-sync" && j.result) || null,
);
const syncFailures = computed(() =>
  groupSyncFailures(lastFullSync.value?.result?.errors),
);
const syncStatus = computed(() => syncVerdict(lastFullSync.value?.result));
async function retryPending() {
  if (
    !confirm(
      "不再重新发现目录，只对尚未生成、上次失败的角色重试；已生成的角色不会重复调用模型。继续？",
    )
  )
    return;
  await act(async () => {
    await $fetch("/v1/admin/ai/full-sync", {
      method: "POST",
      body: { clientId: crypto.randomUUID(), discover: false },
    });
    notice.value = "已入队：只重试未完成角色，不再抓取目录。";
  });
}
async function fullSync(discover = true) {
  if (
    !confirm(
      "从萌娘百科发现全角色，并只为尚未生成的角色抓取原文、调用模型概括提示词。已生成的角色自动跳过，不会重复消耗模型费用；可随时中断，源站连续拒绝时会自动暂停以免触发风控。完成后仍需审核启用。继续？",
    )
  )
    return;
  await act(async () => {
    await $fetch("/v1/admin/ai/full-sync", {
      method: "POST",
      body: { clientId: crypto.randomUUID(), discover: discover },
    });
    notice.value =
      "流水线已入队：已生成角色自动跳过，按真实抓取结果生成，不会伪造缺失资料。";
  });
}
async function cancelJob(id: string) {
  await act(async () => {
    await $fetch(`/v1/admin/ai/jobs/${id}/cancel`, { method: "POST" });
  });
}
async function deleteLog(id?: string) {
  if (
    !confirm(
      id
        ? "删除这条已结束任务日志？"
        : "清空所有已结束的管理任务日志？运行中的任务和审计记录不受影响。",
    )
  )
    return;
  await act(async () => {
    await $fetch("/v1/admin/ai/jobs" + (id ? "/" + id : ""), {
      method: "DELETE",
    });
  });
}
async function catalog() {
  await act(async () => {
    await $fetch("/v1/admin/ai/catalog-sync", {
      method: "POST",
      body: {
        clientId: crypto.randomUUID(),
        skipForeignNames: skipForeignNames.value,
      },
    });
    notice.value =
      "萌娘百科角色发现任务已入队；新发现项保持停用，资料仍需导入、生成与审核。";
  });
}
async function dossiers() {
  if (
    !confirm(
      "对已导入且没有档案的角色批量调用模型，可能产生较多New API费用。确认继续？生成结果仍需审核。",
    )
  )
    return;
  await act(async () => {
    const r = await $fetch<{ remaining: number }>("/v1/admin/ai/dossier-sync", {
      method: "POST",
      body: {
        clientId: crypto.randomUUID(),
        skipForeignNames: skipForeignNames.value,
      },
    });
    notice.value = `批量档案生成已入队，后续批次剩余${r.remaining}个。`;
  });
}
async function syncAll() {
  if (
    !confirm(
      "按队列抓取尚未导入的Wiki角色资料？每批最多填满100个队列位，需要随后生成和审核。已导入的角色会跳过。",
    )
  )
    return;
  await act(async () => {
    await $fetch("/v1/admin/ai/wiki-sync", {
      method: "POST",
      body: {
        clientId: crypto.randomUUID(),
        skipForeignNames: skipForeignNames.value,
      },
    });
    notice.value =
      "批量Wiki导入已入队。抓取受Wiki可用性影响，失败会保留旧档案。";
  });
}
async function article() {
  await act(async () => {
    await $fetch("/v1/admin/ai/articles", {
      method: "POST",
      body: {
        roleId: articleRole.value,
        command: command.value,
        clientId: crypto.randomUUID(),
      },
    });
    notice.value = "写作任务已入队。成功后在后台帖子栏目审核草稿并发布。";
  });
}
async function add() {
  await act(async () => {
    await $fetch("/v1/admin/ai/roles", {
      method: "POST",
      body: { name: customName.value, wiki: customWiki.value },
    });
    customName.value = "";
    customWiki.value = "";
  });
}
watch(
  () => current.value?.avatarUrl,
  (next, previous) => {
    if (editAvatar.value === (previous || "")) editAvatar.value = next || "";
  },
);
watch(selected, () => {
  editAvatar.value = current.value?.avatarUrl || "";
  sourceText.value = "";
  editWiki.value = current.value?.wiki || "";
  editName.value = current.value?.name || "";
  dossierText.value = JSON.stringify(current.value?.dossier || {}, null, 2);
});
onMounted(() => {
  load();
  pollTimer = setInterval(pollJobs, 2500);
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>
<template>
  <div class="resident-admin">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <IkActionButton :disabled="busy" @click="load"
      >刷新AI任务与资料</IkActionButton
    >
    <article>
      <h2>New API 配置</h2>
      <p v-if="pollingError" role="alert">自动刷新失败：{{ pollingError }}</p>
      <p>
        使用OpenAI兼容的 /v1/chat/completions，模型需支持JSON输出。Base
        URL填写网关根地址或以 /v1 结尾的地址。API
        Key仅保存在服务端，不放入角色提示词。
      </p>
      <form @submit.prevent="saveConfig">
        <label
          ><input
            v-model="config.enabled"
            type="checkbox"
          />启用驻站AI服务</label
        ><label
          >New API Base URL<input
            v-model="config.baseUrl"
            placeholder="https://your-new-api.example/v1"
            required /></label
        ><label
          >模型名称<input
            v-model="config.model"
            maxlength="120"
            required /></label
        ><label
          >API Key（{{
            config.hasApiKey ? "已配置；留空保留" : "尚未配置"
          }}）<input
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            maxlength="512" /></label
        ><label
          ><input
            v-model="config.jsonMode"
            type="checkbox"
          />强制JSON模式（模型不支持 response_format
          时关闭；仍会校验输出JSON）</label
        ><IkActionButton :disabled="busy">保存New API配置</IkActionButton>
      </form>
      <IkActionButton :disabled="busy" @click="testConnection">
        测试已保存配置的连接
      </IkActionButton>
      <p
        v-if="connection"
        class="connection-result"
        :data-state="connection.state"
        role="status"
      >
        <b>连接测试：{{ stateNames[connection.state] || connection.state }}</b
        ><span v-if="connection.state === 'done'">
          · {{ connection.result?.message }}</span
        ><span v-if="connection.error"> · {{ connection.error }}</span
        ><small>
          · {{ new Date(connectionStarted).toLocaleTimeString() }} 发起</small
        >
      </p>
    </article>
    <article>
      <h2>萌娘百科 · 全角色资料与提示词</h2>
      <p>
        本次升级已一次性强制清理旧Wiki角色目录，重新使用萌娘百科。全角色来源抓取→AI概括→资料审核→启用；缺失或被源站拒绝的页面明确报错，不伪造完成。
      </p>
      <p>
        目录会同时读取“分类:绝区零”和页面上的“登场角色”导航模板，逐页核对正文后才算角色，组织/音乐/邦布不会混入。已生成的档案自动跳过；失败项直接再次运行即可只重试未完成角色。
      </p>
      <p
        v-if="lastFullSync?.result"
        class="sync-summary"
        :data-tone="syncStatus.tone"
      >
        上次结果：目录 {{ lastFullSync.result.catalog }} 项 · 已完整跳过
        {{ lastFullSync.result.alreadyComplete }} · 本次待处理
        {{ lastFullSync.result.total }} · 已导入
        {{ lastFullSync.result.imported }} · 已生成
        {{ lastFullSync.result.generated }} · 失败
        {{ lastFullSync.result.failed }}。
        {{ syncStatus.text }}
      </p>
      <div v-if="syncFailures.length" class="sync-failures">
        <p>失败原因分组（再次运行只重试这些角色）：</p>
        <ul>
          <li v-for="group in syncFailures" :key="group.error">
            <b>{{ group.error }}</b> × {{ group.names.length }}：{{
              group.names.join("、")
            }}
          </li>
        </ul>
      </div>
      <IkActionButton :disabled="busy" @click="fullSync(true)"
        >发现并生成未完成角色（已生成自动跳过）</IkActionButton
      ><IkActionButton :disabled="busy" @click="retryPending"
        >只重试未完成角色（不再发现目录）</IkActionButton
      >
      <label
        ><input
          type="checkbox"
          v-model="skipForeignNames"
        />发现与批量导入时跳过没有中文名的角色（关闭可包含外语名；单角色仍可自由管理）</label
      >
      <details class="role-catalog">
        <summary>展开全部角色管理 · {{ roles.length }} 项</summary>
        <label
          >搜索角色名或Wiki标题<input
            v-model="roleSearch"
            type="search"
            placeholder="输入中文名或英文标题"
        /></label>
        <div class="role-selection-tools">
          <IkActionButton
            type="button"
            :disabled="busy"
            @click="checkedRoles = roles.map((r) => r.id)"
          >
            全选全部
          </IkActionButton>
          <IkActionButton
            type="button"
            :disabled="busy"
            @click="selectResults()"
          >
            全选搜索结果
          </IkActionButton>
          <IkActionButton
            type="button"
            :disabled="busy"
            @click="selectResults(true)"
          >
            反选搜索结果
          </IkActionButton>
          <IkActionButton
            type="button"
            :disabled="busy"
            @click="checkedRoles = []"
          >
            取消全选
          </IkActionButton>
        </div>
        <p>
          已选
          {{ checkedRoles.length }}
          项 / 全部{{ roles.length }}项 / 搜索结果{{
            filteredRoles.length
          }}项。反选仅改变搜索结果，保留其他已选项。删除支持全量；Wiki/头像任务按队列空位提交，未入队项保持选中。
        </p>
        <div class="role-catalog-list">
          <label v-for="r in filteredRoles" :key="r.id"
            ><input
              v-model="checkedRoles"
              type="checkbox"
              :value="r.id"
              :disabled="busy"
            /><IkActionButton
              type="button"
              :disabled="busy"
              @click="selected = r.id"
            >
              {{ r.name }}</IkActionButton
            ><span
              >{{ r.wiki }} · {{ r.enabled ? "启用" : "停用" }} ·
              {{ r.sourceStatus }}</span
            ></label
          >
        </div>
        <IkActionButton
          :disabled="busy || !checkedRoles.length"
          @click="batch('wiki')"
        >
          导入选中角色Wiki</IkActionButton
        ><IkActionButton
          :disabled="busy || !checkedRoles.length"
          @click="batch('avatar')"
        >
          更新选中角色头像</IkActionButton
        ><IkActionButton
          class="danger"
          :disabled="busy || !checkedRoles.length"
          @click="batch('delete')"
        >
          删除选中角色
        </IkActionButton>
      </details>
      <IkActionButton class="danger" :disabled="busy" @click="cleanupCatalog">
        清理旧版误导入NPC候选
      </IkActionButton>
      <p>
        自动发现仅扫描代理人 Agents，不再扫描整个 NPCs
        分类。哲、铃、Fairy等已有内置角色保留；其他指定角色可手动添加Wiki。
      </p>
      <IkActionButton :disabled="busy" @click="dedupe"
        >清理不同语言的重复目录项</IkActionButton
      >
      <p>
        流程：导入Wiki → 生成详细档案 → 核对来源与档案 → 审核 →
        启用。未核实角色不会自动上线。Wiki/模型内容是不可信资料，不赋予执行权限。防套话是多层防护，不承诺绝对防逆向。
      </p>
      <IkActionButton :disabled="busy" @click="avatars">
        批量更新Wiki头像（不重置档案）</IkActionButton
      ><IkActionButton :disabled="busy" @click="catalog"
        >从萌娘百科发现全角色目录</IkActionButton
      ><IkActionButton :disabled="busy" @click="syncAll"
        >批量导入全部角色Wiki</IkActionButton
      ><IkActionButton :disabled="busy" @click="dossiers">
        批量生成详细档案（消耗模型额度）</IkActionButton
      ><label
        >选择角色<select v-model="selected">
          <option value="">请选择（{{ roles.length }}个目录项）</option>
          <option v-for="r in roles" :key="r.id" :value="r.id">
            {{ r.name }} · {{ r.enabled ? "启用" : "停用" }} ·
            {{ r.sourceStatus }}
          </option>
        </select></label
      >
      <template v-if="current"
        ><h3>{{ current.name }} · {{ current.wiki }}</h3>
        <IkActionButton
          class="danger"
          :disabled="busy"
          @click="removeRole(true)"
        >
          清空Wiki资料</IkActionButton
        ><IkActionButton
          class="danger"
          :disabled="busy"
          @click="removeRole(false)"
        >
          删除此角色
        </IkActionButton>
        <ImageUploadInput
          :key="current.id"
          v-model="editAvatar"
          label="角色头像"
          :disabled="busy"
        />
        <IkActionButton
          :disabled="busy"
          @click="patch({ avatarUrl: editAvatar })"
        >
          保存角色头像
        </IkActionButton>
        <p>
          头像来源：{{
            current.avatarSource === "manual"
              ? "手动设置，Wiki导入不覆盖"
              : "Wiki自动获取"
          }}
          ·
          <a
            :href="
              'https://zenless-zone-zero.fandom.com/wiki/' +
              encodeURIComponent(current.wiki)
            "
            target="_blank"
            rel="noopener noreferrer"
            >角色Wiki图片来源</a
          >
        </p>
        <IkActionButton
          :disabled="busy"
          @click="patch({ avatarSource: 'wiki' })"
        >
          恢复Wiki自动头像（随后点击获取）
        </IkActionButton>
        <IkActionButton
          :disabled="busy || current.avatarSource === 'manual'"
          @click="refreshAvatar"
        >
          获取此角色Wiki头像</IkActionButton
        ><label>显示名<input v-model="editName" maxlength="60" /></label
        ><label
          >Wiki页面标题（修正后需要重新导入/生成/审核）<input
            v-model="editWiki"
            maxlength="120" /></label
        ><IkActionButton
          :disabled="busy"
          @click="patch({ name: editName, wiki: editWiki })"
        >
          保存名称 / Wiki标题</IkActionButton
        ><IkActionButton :disabled="busy" @click="source"
          >查看导入原文以核对</IkActionButton
        >
        <details v-if="sourceText">
          <summary>Wiki导入原文（仅资料）</summary>
          <pre>{{ sourceText }}</pre>
        </details>
        <p>
          审核：{{ current.approved ? "已审核" : "未审核" }} · 来源：{{
            current.sourceStatus
          }}
        </p>
        <ul>
          <li v-for="s in current.sources" :key="s.url">
            <a :href="s.url" target="_blank" rel="noopener noreferrer"
              >Wiki来源</a
            >
            · revision {{ s.revision }} · {{ s.fetchedAt }} ·
            {{ s.verification || "服务器抓取" }}
          </li>
        </ul>
        <IkActionButton :disabled="busy" @click="task('wiki')"
          >导入此角色Wiki</IkActionButton
        ><IkActionButton
          :disabled="busy || current.sourceStatus !== 'imported'"
          @click="task('dossier')"
        >
          生成非常详细的角色档案</IkActionButton
        ><IkActionButton
          :disabled="busy || !current.dossier"
          @click="dossierText = JSON.stringify(current.dossier, null, 2)"
        >
          载入最新档案到编辑器
        </IkActionButton>
        <details>
          <summary>Wiki网络受限时：手动导入Wiki原文</summary>
          <p>
            仅粘贴对应Wiki页面正文，需要管理员核对真实性。此来源明确标为“管理员提供，未由服务器抓取验证”；导入会清除旧审核并停用角色。
          </p>
          <label
            >页面部分<select v-model="manualPart">
              <option value="">主页面</option>
            </select></label
          ><label
            >Wiki修订号（可选）<input
              type="number"
              v-model.number="manualRevision"
              min="1" /></label
          ><label
            >Wiki原文<textarea
              v-model="manualText"
              rows="10"
              maxlength="90000"
            /></label
          ><IkActionButton
            :disabled="busy || manualText.length < 800"
            @click="manualImport"
          >
            导入粘贴的Wiki原文
          </IkActionButton>
        </details>
        <label
          >详细档案（JSON）<textarea
            v-model="dossierText"
            rows="18"
            spellcheck="false"
          /></label
        ><IkActionButton :disabled="busy" @click="saveDossier">
          保存档案（重置审核）</IkActionButton
        ><IkActionButton
          :disabled="busy || !current.dossier"
          @click="patch({ approved: true })"
        >
          我已核对Wiki，审核通过</IkActionButton
        ><IkActionButton
          :disabled="busy || !current.approved"
          @click="patch({ enabled: !current.enabled })"
        >
          {{ current.enabled ? "停用角色" : "启用角色" }}
        </IkActionButton></template
      >
    </article>
    <article>
      <h2>指定 / 随机命令角色写文章</h2>
      <form @submit.prevent="article">
        <label
          >驻站作者<select v-model="articleRole">
            <option value="random">随机已审核启用角色</option>
            <option
              v-for="r in roles.filter((r) => r.enabled && r.approved)"
              :key="r.id"
              :value="r.id"
            >
              {{ r.name }}
            </option>
          </select></label
        ><label
          >角色相关写作命令<textarea
            v-model="command"
            maxlength="2000"
            required
            placeholder="以角色第一人称分享一次与同伴相关的新艾利都日常，明确是同人创作。"
          /></label
        ><IkActionButton :disabled="busy || !command.trim()"
          >生成文章草稿</IkActionButton
        >
      </form>
      <p>不会直接发布；成功后到帖子栏目审核并公开，作者带AI标识。</p>
    </article>
    <article>
      <h2>补充角色（含NPC / 新角色）</h2>
      <form @submit.prevent="add">
        <label
          >显示名<input v-model="customName" maxlength="60" required /></label
        ><label
          >萌娘百科页面标题（例如艾莲·乔）<input
            v-model="customWiki"
            maxlength="120"
            required
            placeholder="例如 Tin Master" /></label
        ><IkActionButton :disabled="busy">新增待导入角色</IkActionButton>
      </form>
    </article>
    <article>
      <h2>任务进度与结果</h2>
      <IkActionButton :disabled="busy" @click="deleteLog()"
        >清空已结束日志</IkActionButton
      >
      <p>
        每2.5秒自动刷新 · 排队
        {{ jobs.filter((j) => j.state === "queued").length }} · 处理
        {{ jobs.filter((j) => j.state === "running").length }} · 成功
        {{ jobs.filter((j) => j.state === "done").length }} · 失败
        {{
          jobs.filter((j) => j.state === "failed").length
        }}。仅展示最近100个管理任务，不包含用户私聊。
      </p>
      <div v-for="j in jobs" :key="j.id" class="job">
        <b
          >{{ roles.find((r) => r.id === j.roleId)?.name || j.roleId }} ·
          {{ kindNames[j.kind] || j.kind }} ·
          {{ stateNames[j.state] || j.state }}</b
        >
        <p v-if="j.progress">
          {{ j.progress.completed }} / {{ j.progress.total }} · 当前
          {{ j.progress.current }} · 已生成 {{ j.progress.generated }} · 失败
          {{ j.progress.failed }}
        </p>
        <IkActionButton
          v-if="['queued', 'running'].includes(j.state)"
          :disabled="busy"
          @click="cancelJob(j.id)"
          >中断任务</IkActionButton
        >
        <IkActionButton v-else :disabled="busy" @click="deleteLog(j.id)"
          >删除日志</IkActionButton
        >
        <pre v-if="j.result">{{ JSON.stringify(j.result, null, 2) }}</pre>
        <p v-if="j.error">{{ j.error }}</p>
        <p v-if="j.result?.postId">草稿ID：{{ j.result.postId }}</p>
      </div>
    </article>
  </div>
</template>
<style scoped>
.sync-summary {
  border-left: 4px solid #d7fa00;
  padding-left: 12px;
}
.sync-failures {
  border: 1px solid #7a4a32;
  background: #2a1d16;
  border-radius: 12px;
  padding: 10px 14px;
}
.sync-failures ul {
  margin: 8px 0 0;
  padding-left: 18px;
}
.sync-failures li {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.role-selection-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.resident-admin {
  color: #dde3d3;
}
.resident-admin article {
  padding: 20px;
  border: 2px solid #414836;
  border-radius: 20px;
  background: #20251c;
  margin: 18px 0;
}
.resident-admin input:not([type="checkbox"]),
.resident-admin textarea,
.resident-admin select {
  display: block;
  width: 100%;
  box-sizing: border-box;
  background: #10130d;
  border: 1px solid #64704e;
  border-radius: 10px;
  color: #e5ecd9;
  padding: 12px;
}
.resident-admin label {
  display: block;
  margin: 14px 0;
}
.resident-admin input[type="checkbox"] {
  width: auto;
  display: inline;
}
.resident-admin button:not(.z-button) {
  padding: 9px 14px;
  border-radius: 18px;
  background: #d7fa00;
  color: #171e0a;
  margin: 4px;
  cursor: pointer;
}
.resident-admin button:disabled {
  opacity: 0.45;
  cursor: default;
}
.resident-admin a {
  color: #d7fa00;
}
.resident-admin p,
.resident-admin b {
  overflow-wrap: anywhere;
}
.resident-admin pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 400px;
  overflow: auto;
}
.job {
  border-bottom: 1px solid #414836;
  padding: 12px 0;
}
.connection-result {
  padding: 16px;
  border: 1px solid #6c735a;
  border-radius: 12px;
}
.connection-result[data-state="done"] {
  border-color: #d7fa00;
  color: #d7fa00;
}
.connection-result[data-state="failed"] {
  border-color: #ff987c;
  color: #ffba9e;
}
.resident-admin .danger {
  background: #ffd1bb;
}
.job {
  overflow-wrap: anywhere;
}
[role="alert"] {
  color: #ffba9e;
}
.role-catalog {
  padding: 15px;
  border: 1px solid #536043;
  border-radius: 12px;
  margin: 12px 0;
}
.role-catalog summary {
  cursor: pointer;
  color: #d7fa00;
}
.role-catalog-list {
  max-height: 340px;
  overflow: auto;
  overscroll-behavior: contain;
}
.role-catalog-list label {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #39452e;
  padding: 7px;
  margin: 0;
}
.role-catalog-list input[type="checkbox"] {
  display: inline-block;
  width: 18px;
  flex-shrink: 0;
}
.role-catalog-list span {
  overflow-wrap: anywhere;
  font-size: 11px;
  color: #a2ac96;
}
</style>
