<script setup lang="ts">
const auth = useAuthStore();
</script>
<template>
  <div v-if="auth.isLogin" class="home-account-tools">
    <span class="mobile-wallet"
      ><span title="丁尼余额"
        ><img src="/images/materials/dennies_v2.webp" alt="丁尼" />{{
          auth.user?.denny ?? 0
        }}</span
      ><span title="这是珍贵的货币"
        ><img src="/images/materials/polychrome.svg" alt="菲林" />{{
          auth.user?.polychrome ?? 0
        }}</span
      ></span
    ><NuxtLink v-if="auth.user?.isAdmin" to="/admin">管理后台 →</NuxtLink
    ><NuxtLink to="/activity">日程 / 通知 →</NuxtLink
    ><NuxtLink to="/level">等级 / 签到 →</NuxtLink
    ><NuxtLink to="/messages">敲敲 →</NuxtLink>
  </div>
</template>
<style scoped>
.mobile-wallet {
  display: none;
}
.mobile-wallet > span {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 2px solid #444;
  border-radius: 999px;
  padding: 4px 12px;
  background: #121212 url("/images/tab-bg-point.webp") repeat;
  font-weight: 800;
}
.mobile-wallet img {
  width: 24px;
  height: 24px;
  vertical-align: middle;
}
@media (max-width: 1100px) {
  .mobile-wallet {
    display: flex;
    gap: 14px;
    align-items: center;
  }
}
.home-account-tools {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  color: #c4ccb6;
  font-size: 13px;
}
.home-account-tools b,
.home-account-tools a {
  color: #d7fa00;
}
.home-account-tools a {
  border: 1px solid #626b50;
  border-radius: 999px;
  padding: 7px 14px;
  text-decoration: none;
}
.home-account-tools small {
  margin-left: 8px;
  color: #8b947e;
  font-size: 10px;
}
</style>
