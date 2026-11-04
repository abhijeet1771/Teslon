<template>
  <NavBar />
  <main class="container">
    <RouterView />
  </main>
  <ToastHost />
</template>

<script setup lang="ts">
import NavBar from './components/NavBar.vue';
import ToastHost from './components/ToastHost.vue';
</script>
