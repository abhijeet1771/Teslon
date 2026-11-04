<template>
  <section>
    <h1>Dashboard</h1>
    <div class="tiles">
      <div class="tile">
        <h2>Open orders</h2>
        <p class="big">{{ orders.open.length }}</p>
      </div>
      <div class="tile">
        <h2>Revenue</h2>
        <p class="big"><MoneyText :amount="orders.revenue" /></p>
      </div>
    </div>
    <h2>Latest orders</h2>
    <ul>
      <li v-for="o in orders.latest" :key="o.id">
        <RouterLink :to="`/orders/${o.id}`">#{{ o.id }} {{ o.customerName }}</RouterLink>
        <StatusBadge :status="o.status" />
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import MoneyText from '../components/MoneyText.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useOrdersStore } from '../stores/orders';

const orders = useOrdersStore();
onMounted(() => orders.load());
</script>
