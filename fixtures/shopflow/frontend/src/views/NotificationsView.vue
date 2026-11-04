<template>
  <section>
    <h1>Notifications</h1>
    <table>
      <thead>
        <tr><th>Sent</th><th>Order</th><th>To</th><th>Kind</th><th>Subject</th><th>Status</th></tr>
      </thead>
      <tbody>
        <tr v-for="n in items" :key="n.id">
          <td>{{ formatDate(n.sentAt) }}</td>
          <td><RouterLink :to="`/orders/${n.orderId}`">#{{ n.orderId }}</RouterLink></td>
          <td>{{ n.recipient }}</td>
          <td>{{ n.kind }}</td>
          <td>{{ n.subject }}</td>
          <td>{{ n.status }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchNotifications } from '../api/notifications';
import { formatDate } from '../utils/format';
import type { Notification } from '../types';

const items = ref<Notification[]>([]);

onMounted(async () => {
  items.value = await fetchNotifications();
});
</script>
