<script setup lang="ts">
interface Role {
  id: string;
  name: string;
  wiki: string;
  kind: string;
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
  result?: { postId?: string };
}
const config = ref({
    enabled: false,
    baseUrl: "",
    model: "",
    hasApiKey: false,
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
const sourceText = ref(""),
  editWiki = ref(""),
  editName = ref("");
const manualText = ref(""),
  manualPart = ref("Lore"),
  manualRevision = ref<number | undefined>();
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
async function load() {
  try {
    const [c, r, j] = await Promise.all([
      $fetch<typeof config.value>("/v1/admin/ai/config"),
      $fetch<{ items: Role[] }>("/v1/admin/ai/roles"),
      $fetch<{ items: Job[] }>("/v1/admin/ai/jobs"),
    ]);
    config.value = c;
    roles.value = r.items;
    jobs.value = j.items;
  } catch (e) {
    error.value = detail(e);
  }
}
async function act(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
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
      body: { clientId: crypto.randomUUID() },
    });
    notice.value = "任务已加入队列，请刷新查看完成状态。";
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
async function catalog() {
  await act(async () => {
    await $fetch("/v1/admin/ai/catalog-sync", {
      method: "POST",
      body: { clientId: crypto.randomUUID() },
    });
    notice.value =
      "Wiki角色/NPC目录发现任务已入队；新发现项保持停用，资料仍需导入、生成与审核。";
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
      body: { clientId: crypto.randomUUID() },
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
      body: { clientId: crypto.randomUUID() },
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
watch(selected, () => {
  sourceText.value = "";
  editWiki.value = current.value?.wiki || "";
  editName.value = current.value?.name || "";
  dossierText.value = JSON.stringify(current.value?.dossier || {}, null, 2);
});
onMounted(load);
</script>
<template>
  <div class="resident-admin">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <button :disabled="busy" @click="load">刷新AI任务与资料</button>
    <article>
      <h2>New API 配置</h2>
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
        ><button :disabled="busy">保存New API配置</button>
      </form>
    </article>
    <article>
      <h2>驻站角色资料与审核</h2>
      <p>
        流程：导入Wiki → 生成详细档案 → 核对来源与档案 → 审核 →
        启用。未核实角色不会自动上线。Wiki/模型内容是不可信资料，不赋予执行权限。防套话是多层防护，不承诺绝对防逆向。
      </p>
      <button :disabled="busy" @click="catalog">从Wiki发现角色 / NPC目录</button
      ><button :disabled="busy" @click="syncAll">批量导入全部角色Wiki</button
      ><button :disabled="busy" @click="dossiers">
        批量生成详细档案（消耗模型额度）</button
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
        <label>显示名<input v-model="editName" maxlength="60" /></label
        ><label
          >Wiki页面标题（修正后需要重新导入/生成/审核）<input
            v-model="editWiki"
            maxlength="120" /></label
        ><button
          :disabled="busy"
          @click="patch({ name: editName, wiki: editWiki })"
        >
          保存名称 / Wiki标题</button
        ><button :disabled="busy" @click="source">查看导入原文以核对</button>
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
        <button :disabled="busy" @click="task('wiki')">导入此角色Wiki</button
        ><button
          :disabled="busy || current.sourceStatus !== 'imported'"
          @click="task('dossier')"
        >
          生成非常详细的角色档案</button
        ><button
          :disabled="busy || !current.dossier"
          @click="dossierText = JSON.stringify(current.dossier, null, 2)"
        >
          载入最新档案到编辑器
        </button>
        <details>
          <summary>Wiki网络受限时：手动导入Wiki原文</summary>
          <p>
            仅粘贴对应Wiki页面正文，需要管理员核对真实性。此来源明确标为“管理员提供，未由服务器抓取验证”；导入会清除旧审核并停用角色。
          </p>
          <label
            >页面部分<select v-model="manualPart">
              <option value="">主页面</option>
              <option value="Lore">Lore</option>
              <option value="Voice-Overs">Voice-Overs</option>
              <option value="DMs">DMs</option>
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
          ><button
            :disabled="busy || manualText.length < 800"
            @click="manualImport"
          >
            导入粘贴的Wiki原文
          </button>
        </details>
        <label
          >详细档案（JSON）<textarea
            v-model="dossierText"
            rows="18"
            spellcheck="false"
          /></label
        ><button :disabled="busy" @click="saveDossier">
          保存档案（重置审核）</button
        ><button
          :disabled="busy || !current.dossier"
          @click="patch({ approved: true })"
        >
          我已核对Wiki，审核通过</button
        ><button
          :disabled="busy || !current.approved"
          @click="patch({ enabled: !current.enabled })"
        >
          {{ current.enabled ? "停用角色" : "启用角色" }}
        </button></template
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
        ><button :disabled="busy || !command.trim()">生成文章草稿</button>
      </form>
      <p>不会直接发布；成功后到帖子栏目审核并公开，作者带AI标识。</p>
    </article>
    <article>
      <h2>补充角色（含NPC / 新角色）</h2>
      <form @submit.prevent="add">
        <label
          >显示名<input v-model="customName" maxlength="60" required /></label
        ><label
          >此Wiki站的英文页面标题<input
            v-model="customWiki"
            maxlength="120"
            required
            placeholder="例如 Tin Master" /></label
        ><button :disabled="busy">新增待导入角色</button>
      </form>
    </article>
    <article>
      <h2>最近任务（不包含用户私聊）</h2>
      <div v-for="j in jobs" :key="j.id" class="job">
        <b
          >{{ roles.find((r) => r.id === j.roleId)?.name || j.roleId }} ·
          {{ j.kind }} · {{ j.state }}</b
        >
        <p v-if="j.error">{{ j.error }}</p>
        <p v-if="j.result?.postId">草稿ID：{{ j.result.postId }}</p>
      </div>
    </article>
  </div>
</template>
<style scoped>
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
.resident-admin button {
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
[role="alert"] {
  color: #ffba9e;
}
</style>
