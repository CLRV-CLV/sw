<script setup lang="ts">
const route = useRoute();
</script>
<template><NuxtPage v-if="route.path === '/web/admin'" /><LayoutViewport v-else mode="web" /></template>
