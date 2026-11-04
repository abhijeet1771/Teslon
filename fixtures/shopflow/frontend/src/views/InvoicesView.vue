<template>
  <section>
    <h1>Invoices</h1>
    <label>
      Status
      <select v-model="filter">
        <option value="ALL">All</option>
        <option value="OPEN">Open</option>
        <option value="PAID">Paid</option>
        <option value="FAILED">Failed</option>
        <option value="VOID">Void</option>
      </select>
    </label>
    <table>
      <thead>
        <tr><th>Number</th><th>Order</th><th>Customer</th><th>Gross</th><th>Status</th><th>Issued</th></tr>
      </thead>
      <tbody>
        <tr v-for="inv in shown" :key="inv.id">
          <td><RouterLink :to="`/invoices/${inv.id}`">{{ inv.number }}</RouterLink></td>
          <td><RouterLink :to="`/orders/${inv.orderId}`">#{{ inv.orderId }}</RouterLink></td>
          <td>{{ inv.customerEmail }}</td>
          <td><MoneyText :amount="inv.gross" :currency="inv.currency" /></td>
          <td><StatusBadge :status="inv.status" /></td>
          <td>{{ formatDate(inv.issuedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import MoneyText from '../components/MoneyText.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { invoicesApi } from '../api/invoices';
import { formatDate } from '../utils/format';
import type { Invoice } from '../types';

export default defineComponent({
  name: 'InvoicesView',
  components: { MoneyText, StatusBadge },
  data() {
    return {
      invoices: [] as Invoice[],
      filter: 'ALL',
    };
  },
  computed: {
    shown(): Invoice[] {
      return this.filter === 'ALL' ? this.invoices : this.invoices.filter((i) => i.status === this.filter);
    },
  },
  async mounted() {
    this.invoices = await invoicesApi.list();
  },
  methods: { formatDate },
});
</script>
