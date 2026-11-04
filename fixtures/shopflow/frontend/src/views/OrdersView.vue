<template>
  <section>
    <header class="row">
      <h1>Orders</h1>
      <RouterLink to="/orders/new" class="button">New order</RouterLink>
    </header>
    <p v-if="store.loading">Loading…</p>
    <table v-else>
      <thead>
        <tr><th>#</th><th>Customer</th><th>Status</th><th>Total</th><th>Placed</th></tr>
      </thead>
      <tbody>
        <tr v-for="order in store.orders" :key="order.id">
          <td><RouterLink :to="`/orders/${order.id}`">{{ order.id }}</RouterLink></td>
          <td>{{ order.customerName }}</td>
          <td><StatusBadge :status="order.status" /></td>
          <td><MoneyText :amount="order.total" :currency="order.currency" /></td>
          <td>{{ formatDate(order.placedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import MoneyText from '../components/MoneyText.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useOrdersStore } from '../stores/orders';
import { formatDate } from '../utils/format';

const store = useOrdersStore();
onMounted(() => store.load());
</script>
