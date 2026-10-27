<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    subtitle?: string;
    index?: string;
    description?: string;
  }>(),
  {
    title: "绳网",
    subtitle: "INTER-KNOT",
    index: "01",
    description: "情报、委托、还有街头巷尾的大小事。",
  },
);
</script>
<template>
  <header class="ik-terminal-masthead">
    <div class="ik-terminal-masthead__copy">
      <div class="ik-terminal-masthead__eyebrow">
        <span class="ik-terminal-dot" /> 新艾利都 · 民间情报网络
        <span>NO. {{ index.padStart(3, "0") }} / PUBLIC ACCESS</span>
      </div>
      <h1>
        {{ title }}<span>{{ subtitle }}</span
        ><i>!</i>
      </h1>
      <p>{{ description }}<b>信号已接通。</b></p>
    </div>
    <div class="ik-terminal-masthead__art" aria-hidden="true">
      <img src="/images/zzz.webp" alt="" /><span
        >STAY CONNECTED.<br />STAY IN THE LOOP.</span
      >
    </div>
    <div class="ik-terminal-masthead__index" aria-hidden="true">
      {{ index }}<br /><small>CHANNEL</small>
    </div>
  </header>
</template>
