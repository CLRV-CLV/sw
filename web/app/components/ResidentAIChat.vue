<script setup lang="ts">
interface Role {
  id: string;
  name: string;
  available: boolean;
  avatarUrl: string;
  summary: string;
  sources: { url: string; fetchedAt: string; verification?: string }[];
}
interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
interface Job {
  id: string;
  state: string;
  error?: string;
  result?: { reply?: string };
}
const roles = ref<Role[]>([]),
  selected = ref(""),
  items = ref<Message[]>([]),
  content = ref(""),
  error = ref(""),
  busy = ref(false),
  cursor = ref<string | null>(null),
  pending = ref<{ id: string; content: string; roleId: string } | null>(null);
const active = computed(() => roles.value.find((r) => r.id === selected.value)),
  box = ref<HTMLElement | null>(null);
let disposed = false,
  epoch = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
function detail(e: unknown) {
  return (
    (e as { data?: { detail?: string } }).data?.detail ||
    "驻站AI连接失败，可重试同一任务"
  );
}
async function loadRoles() {
  try {
    roles.value = (await $fetch<{ items: Role[] }>("/v1/ai/roles")).items;
  } catch (e) {
    error.value = detail(e);
  }
}
async function history(older = false) {
  const id = selected.value;
  if (!id) return;
  try {
    const r = await $fetch<{
      items: Message[];
      nextCursor: string | null;
      pendingJob?: Job;
    }>(`/v1/ai/chats/${id}`, {
      query: older && cursor.value ? { cursor: cursor.value } : {},
    });
    if (id !== selected.value || disposed) return;
    items.value = older ? [...r.items, ...items.value] : r.items;
    cursor.value = r.nextCursor;
    await nextTick();
    if (!older && box.value) box.value.scrollTop = box.value.scrollHeight;
    if (r.pendingJob && !busy.value) poll(r.pendingJob.id, epoch);
  } catch (e) {
    error.value = detail(e);
  }
}
async function poll(id: string, generation: number) {
  busy.value = true;
  try {
    const job = await $fetch<Job>(`/v1/ai/jobs/${id}`);
    if (disposed || generation !== epoch) return;
    if (job.state === "done") {
      pending.value = null;
      content.value = "";
      busy.value = false;
      await history();
      return;
    }
    if (job.state === "failed") {
      error.value = job.error || "AI任务失败";
      pending.value = null;
      busy.value = false;
      return;
    }
    timer = setTimeout(() => poll(id, generation), 1500);
  } catch (e) {
    if (generation === epoch && !disposed) {
      error.value = detail(e);
      busy.value = false;
    }
  }
}
async function send() {
  if (busy.value || !active.value?.available || !content.value.trim()) return;
  error.value = "";
  busy.value = true;
  const generation = epoch;
  if (
    !pending.value ||
    pending.value.roleId !== selected.value ||
    pending.value.content !== content.value
  )
    pending.value = {
      id: crypto.randomUUID(),
      content: content.value,
      roleId: selected.value,
    };
  try {
    const p = pending.value;
    const job = await $fetch<Job>(`/v1/ai/chats/${p.roleId}/turns`, {
      method: "POST",
      body: { content: p.content, clientId: p.id },
    });
    if (!disposed && generation === epoch) poll(job.id, generation);
  } catch (e) {
    if (generation === epoch && !disposed) {
      error.value = detail(e);
      busy.value = false;
    }
  }
}
watch(selected, () => {
  epoch++;
  if (timer) clearTimeout(timer);
  items.value = [];
  cursor.value = null;
  content.value = "";
  pending.value = null;
  error.value = "";
  busy.value = false;
  history();
});
onMounted(loadRoles);
onBeforeUnmount(() => {
  disposed = true;
  epoch++;
  if (timer) clearTimeout(timer);
});
</script>
<template>
  <div class="ai-chat">
    <aside>
      <h2>驻站角色 · AI</h2>
      <p>
        仅限角色相关话题。这是本站AI角色扮演，不是官方角色本人。未审核或未配置的角色不能聊天。
      </p>
      <button @click="loadRoles">刷新角色状态</button
      ><button
        v-for="r in roles"
        :key="r.id"
        class="role"
        :aria-pressed="selected === r.id"
        @click="selected = r.id"
      >
        <img :src="r.avatarUrl" alt="" /><span
          >{{ r.name
          }}<small>{{ r.available ? "可聊天" : "待配置 / 审核" }}</small></span
        >
      </button>
    </aside>
    <article>
      <template v-if="active"
        ><h2>{{ active.name }} <small>AI角色扮演</small></h2>
        <details>
          <summary>角色简介与来源</summary>
          <p>{{ active.summary }}</p>
          <a
            v-for="s in active.sources"
            :key="s.url"
            :href="s.url"
            target="_blank"
            rel="noopener noreferrer"
            >Wiki资料 · {{ s.fetchedAt }} ·
            {{
              s.verification === "administrator-provided-not-fetched"
                ? "管理员提供原文"
                : "服务器抓取"
            }}</a
          >
        </details>
        <p v-if="error" role="alert">{{ error }}</p>
        <button v-if="cursor" @click="history(true)">更早的对话</button>
        <div ref="box" class="ai-timeline" aria-live="polite">
          <div
            v-for="m in items"
            :key="m.id"
            class="ai-bubble"
            :class="{ mine: m.role === 'user' }"
          >
            <small
              >{{ m.role === "user" ? "我" : `${active.name}（AI）` }} ·
              {{ m.createdAt }}</small
            >
            <p>{{ m.content }}</p>
          </div>
          <p v-if="!items.length">
            聊聊{{ active.name }}的同伴、经历或日常吧。
          </p>
        </div>
        <p v-if="!active.available">
          请等待管理员配置New API并导入、审核此角色的Wiki资料。
        </p>
        <form @submit.prevent="send">
          <textarea
            v-model="content"
            aria-label="给驻站AI的消息"
            placeholder="仅聊角色相关的话题…"
            maxlength="3000"
            :disabled="busy || !active.available"
          /><button :disabled="busy || !active.available || !content.trim()">
            {{ busy ? "角色正在回复…" : "发送给角色" }}
          </button>
        </form>
        <small
          >每账号每分钟5次、滚动24小时50次；不要发送口令和隐私。回复会被模型服务处理。</small
        ></template
      >
      <p v-else>选择一个角色开始敲敲对话。</p>
    </article>
  </div>
</template>
<style scoped>
.ai-chat {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 18px;
}
.ai-chat aside,
.ai-chat article {
  background: #20251c;
  border: 2px solid #414c33;
  border-radius: 22px;
  padding: 18px;
  min-width: 0;
}
.ai-chat aside {
  max-height: 760px;
  overflow: auto;
}
.role {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
}
.role img {
  width: 36px;
  height: 36px;
  border-radius: 50%;
}
.role small {
  display: block;
}
.role[aria-pressed="true"] {
  border-color: #d7fa00;
}
.ai-chat button {
  border: 1px solid #69754c;
  background: #222b17;
  color: #e5ecd9;
  padding: 10px 14px;
  border-radius: 18px;
  margin: 4px 0;
  cursor: pointer;
}
.ai-chat button:disabled {
  opacity: 0.5;
  cursor: default;
}
.ai-chat small {
  color: #adb69d;
}
.ai-timeline {
  height: 460px;
  overflow: auto;
}
.ai-bubble {
  background: #13190d;
  padding: 14px;
  border-radius: 18px;
  margin: 12px 0;
  max-width: 85%;
  overflow-wrap: anywhere;
}
.ai-bubble.mine {
  margin-left: auto;
  border: 1px solid #6c7a49;
}
.ai-bubble p {
  white-space: pre-wrap;
}
.ai-chat form {
  display: flex;
  gap: 8px;
  margin: 14px 0;
}
.ai-chat textarea {
  background: #11180a;
  border: 1px solid #66744d;
  border-radius: 12px;
  color: #eee;
  padding: 12px;
  flex: 1;
  min-width: 0;
}
.ai-chat a {
  display: block;
  color: #d7fa00;
  overflow-wrap: anywhere;
}
.ai-chat [role="alert"] {
  color: #ffb79e;
}
@media (max-width: 768px) {
  .ai-chat {
    grid-template-columns: 1fr;
  }
  .ai-chat aside {
    max-height: 280px;
  }
  .ai-timeline {
    height: 340px;
  }
}
</style>
