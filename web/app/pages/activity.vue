<script setup lang="ts">
interface Task {
  id: string;
  title: string;
  notes?: string;
  dueAt: string | null;
  done: boolean;
}
interface Notice {
  id: string;
  text: string;
  href: string;
  read: boolean;
  createdAt: string;
}
interface Peer {
  id: string;
  name: string;
}
const auth = useAuthStore(),
  login = useLoginDialog();
const tasks = ref<Task[]>([]),
  notifications = ref<Notice[]>([]),
  logs = ref<
    {
      id: string;
      amount: number;
      description: string;
      balance: number;
      createdAt: string;
    }[]
  >([]),
  contacts = ref<Peer[]>([]),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  balance = ref(0),
  taskTitle = ref(""),
  dueAt = ref(""),
  peer = ref(""),
  amount = ref(1),
  transferKey = ref(crypto.randomUUID());
function message(e: unknown) {
  return (
    (e as { data?: { detail?: string } })?.data?.detail ||
    "请求失败，请稍后重试"
  );
}
async function load() {
  if (!auth.isLogin) return;
  error.value = "";
  try {
    const [t, n, w, l, c] = await Promise.all([
      $fetch<{ items: Task[] }>("/v1/me/tasks"),
      $fetch<{ items: Notice[] }>("/v1/me/notifications"),
      $fetch<{ balance: number }>("/v1/me/wallet"),
      $fetch<{ items: typeof logs.value }>("/v1/me/denny-logs"),
      $fetch<{ items: Peer[] }>("/v1/dm/contacts"),
    ]);
    tasks.value = t.items;
    notifications.value = n.items;
    balance.value = w.balance;
    logs.value = l.items;
    contacts.value = c.items;
  } catch (e) {
    error.value = message(e);
  }
}
async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    await load();
    await auth.fetchSelfUser();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function addTask() {
  await run(async () => {
    await $fetch("/v1/me/tasks", {
      method: "POST",
      body: {
        title: taskTitle.value,
        dueAt: dueAt.value ? new Date(dueAt.value).toISOString() : null,
      },
    });
    taskTitle.value = "";
    dueAt.value = "";
  });
}
async function toggle(t: Task) {
  await run(() =>
    $fetch(`/v1/me/tasks/${t.id}`, {
      method: "PATCH",
      body: { done: !t.done },
    }),
  );
}
async function remove(t: Task) {
  if (confirm("删除这条日程？"))
    await run(() => $fetch(`/v1/me/tasks/${t.id}`, { method: "DELETE" }));
}
async function transfer() {
  const target = contacts.value.find((p) => p.id === peer.value);
  if (
    !target ||
    !confirm(`向 ${target.name} 转账 ${amount.value} 丁尼？确认后立即到账。`)
  )
    return;
  await run(async () => {
    await $fetch("/v1/me/transfers", {
      method: "POST",
      body: {
        peerId: peer.value,
        amount: amount.value,
        clientId: transferKey.value,
      },
    });
    transferKey.value = crypto.randomUUID();
    notice.value = "转账已到账，双方均已记账。";
  });
}
onMounted(load);
watch(
  () => auth.isLogin,
  (active) => {
    if (active) load();
    else {
      tasks.value = [];
      notifications.value = [];
      logs.value = [];
      contacts.value = [];
    }
  },
);
</script>
<template>
  <section class="activity-page">
    <TerminalMasthead
      title="日常"
      subtitle="MY DESK"
      index="03"
      description="日程、消息与丁尼，放在同一张桌面。"
    />
    <nav>
      <NuxtLink to="/">← 推送</NuxtLink
      ><NuxtLink to="/level">等级 / 签到</NuxtLink
      ><NuxtLink to="/account">账号安全</NuxtLink
      ><IkActionButton :disabled="busy" @click="load">刷新</IkActionButton>
    </nav>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <IkActionButton v-if="!auth.isLogin" @click="login.open()"
      >登录本站</IkActionButton
    >
    <div v-else class="activity-grid">
      <article>
        <h2>我的日程</h2>
        <p class="muted">
          跨设备保存。当前页面会标出到期事项，不是系统推送提醒。
        </p>
        <form @submit.prevent="addTask">
          <label
            >日程标题<input
              v-model="taskTitle"
              maxlength="200"
              required /></label
          ><label
            >截止时间（可选）<input
              v-model="dueAt"
              type="datetime-local" /></label
          ><IkActionButton :disabled="busy">添加日程</IkActionButton>
        </form>
        <div
          v-for="t in tasks"
          :key="t.id"
          class="task"
          :class="{
            overdue: !t.done && t.dueAt && Date.parse(t.dueAt) < Date.now(),
          }"
        >
          <label
            ><input
              type="checkbox"
              :checked="t.done"
              :disabled="busy"
              @change="toggle(t)"
            /><span :class="{ done: t.done }">{{ t.title }}</span></label
          ><small v-if="t.dueAt">{{ new Date(t.dueAt).toLocaleString() }}</small
          ><IkActionButton :disabled="busy" @click="remove(t)"
            >删除</IkActionButton
          >
        </div>
        <p v-if="!tasks.length" class="muted">还没有日程。</p>
      </article>
      <article>
        <h2>通知</h2>
        <IkActionButton
          :disabled="busy"
          @click="
            run(() =>
              $fetch('/v1/me/notifications/read', {
                method: 'POST',
                body: { all: true },
              }),
            )
          "
        >
          全部标记已读
        </IkActionButton>
        <div
          v-for="n in notifications"
          :key="n.id"
          class="notification"
          :class="{ unread: !n.read }"
        >
          <NuxtLink :to="n.href">{{ n.text }}</NuxtLink
          ><small>{{ new Date(n.createdAt).toLocaleString() }}</small
          ><IkActionButton
            v-if="!n.read"
            :disabled="busy"
            @click="
              run(() =>
                $fetch('/v1/me/notifications/read', {
                  method: 'POST',
                  body: { ids: [n.id] },
                }),
              )
            "
          >
            已读
          </IkActionButton>
        </div>
        <p v-if="!notifications.length" class="muted">暂时没有新通知。</p>
      </article>
      <article>
        <h2>
          丁尼账户 <b>{{ balance }}</b>
        </h2>
        <form @submit.prevent="transfer">
          <label
            >收款人<select v-model="peer" required>
              <option value="">请选择用户</option>
              <option v-for="p in contacts" :key="p.id" :value="p.id">
                {{ p.name }} · {{ p.id.slice(0, 8) }}
              </option>
            </select></label
          ><label
            >转账金额<input
              v-model.number="amount"
              type="number"
              min="1"
              max="1000000"
              step="1"
              required /></label
          ><IkActionButton :disabled="busy || !peer">确认转账</IkActionButton>
        </form>
        <p class="muted">丁尼是站内虚拟资产，不是现实货币。转账会立即到账。</p>
        <div v-for="l in logs" :key="l.id" class="log">
          <span>{{ l.description }}</span
          ><b>{{ l.amount > 0 ? "+" : "" }}{{ l.amount }}</b
          ><small
            >余额 {{ l.balance }} ·
            {{ new Date(l.createdAt).toLocaleString() }}</small
          >
        </div>
      </article>
    </div>
  </section>
</template>
<style scoped>
.activity-page {
  width: min(1600px, calc(100% - 48px));
  margin: auto;
  padding: 24px 0 100px;
  color: var(--ik-text);
}
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: center;
  margin: 0 0 24px;
}
a {
  color: #d7fa00;
}
button:not(.z-button) {
  border: 1px solid #5c644d;
  background: #202220;
  color: #e5e7df;
  border-radius: 10px 10px 0 10px;
  padding: 8px 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
}
.activity-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
}
article {
  border: 1px solid #484b43;
  border-radius: var(--ik-post-card-radius);
  background: var(--ik-post-card-inner-bg);
  box-shadow: 3px 4px #050605;
  padding: 24px;
  min-width: 0;
}
h2 {
  font-size: 20px;
}
h2 b {
  color: #d7fa00;
  margin-left: 12px;
}
label {
  display: block;
  margin: 12px 0;
  font-size: 13px;
}
input:not([type="checkbox"]),
select {
  display: block;
  width: 100%;
  padding: 12px;
  border-radius: 9px;
  border: 1px solid #555;
  background: #171916;
  color: #eee;
  margin-top: 8px;
  box-sizing: border-box;
  min-width: 0;
}
form > button {
  background: #d7fa00;
  color: #151a0e;
  font-weight: 800;
}
.muted,
small {
  font-size: 11px;
  color: #a1a595;
  line-height: 1.8;
}
small {
  display: block;
}
.task,
.notification,
.log {
  padding: 15px 0;
  border-top: 1px solid #45473f;
  margin-top: 12px;
  overflow-wrap: anywhere;
}
.task label {
  display: flex;
  gap: 10px;
  align-items: center;
}
.done {
  text-decoration: line-through;
  color: #8d9582;
}
.overdue {
  border-left: 3px solid #e3b064;
  padding-left: 12px;
}
.unread {
  border-left: 3px solid #d7fa00;
  padding-left: 12px;
}
.log b {
  float: right;
}
.log small {
  clear: both;
}
[role="alert"] {
  color: #ffc1ad;
}
@media (max-width: 1100px) {
  .activity-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 768px) {
  .activity-page {
    width: calc(100% - 16px);
    padding-top: 15px;
  }
  .activity-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  article {
    padding: 18px;
  }
}
</style>
