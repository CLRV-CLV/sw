<script setup lang="ts">
const auth=useAuthStore();
</script>
<template><div v-if="auth.isLogin" class="home-account-tools"><span title="这是珍贵的货币">✦ 菲林 <b>{{ auth.user?.polychrome ?? 0 }}</b><small>珍贵的货币</small></span><span>丁尼 {{ auth.user?.denny ?? 0 }}</span><NuxtLink v-if="auth.user?.isAdmin" to="/admin">管理后台 →</NuxtLink><NuxtLink to="/activity">日程 / 通知 →</NuxtLink><NuxtLink to="/level">等级 / 签到 →</NuxtLink><NuxtLink to="/messages">敲敲 →</NuxtLink></div></template>
<style scoped>.home-account-tools{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:14px;color:#c4ccb6;font-size:13px}.home-account-tools b,.home-account-tools a{color:#d7fa00}.home-account-tools a{border:1px solid #626b50;border-radius:999px;padding:7px 14px;text-decoration:none}.home-account-tools small{margin-left:8px;color:#8b947e;font-size:10px}</style>
