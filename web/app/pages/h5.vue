<script setup lang="ts">
const route = useRoute();
</script>
<template><NuxtPage v-if="route.path === '/h5/admin'" /><LayoutViewport v-else mode="h5" /></template>
