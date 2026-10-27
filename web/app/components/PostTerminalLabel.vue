<script setup lang="ts">
defineProps<{ category?: string; postId: string }>();
</script>

<template>
  <div class="post-terminal-label">
    <span class="post-terminal-label__channel">{{ category || '绳网动态' }}</span>
    <span class="post-terminal-label__code">IK / {{ postId.slice(-8).toUpperCase() }}</span>
    <span class="post-terminal-label__bars" aria-hidden="true" />
  </div>
</template>

<style scoped>
.post-terminal-label{display:flex;align-items:center;gap:12px;border-bottom:2px solid #494c40;padding:0 0 13px;margin-bottom:20px;color:#bfc2b1}
.post-terminal-label__channel{background:#dbfa15;color:#121510;transform:skew(-9deg);padding:5px 10px;border-radius:4px 4px 0 4px;font-size:12px;font-weight:900}
.post-terminal-label__code{font:10px monospace;letter-spacing:1px}
.post-terminal-label__bars{margin-left:auto;width:45px;height:19px;background:repeating-linear-gradient(90deg,#9a9e8e 0 2px,transparent 2px 5px,#9a9e8e 5px 6px,transparent 6px 9px)}
@media(max-width:480px){.post-terminal-label{gap:8px}.post-terminal-label__code{font-size:9px}.post-terminal-label__bars{width:27px}}
</style>
