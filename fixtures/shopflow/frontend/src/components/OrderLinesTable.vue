<template>
  <table class="lines">
    <thead>
      <tr><th>Product</th><th>SKU</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr>
    </thead>
    <tbody>
      <tr v-for="line in lines" :key="line.sku">
        <td>{{ line.productName }}</td>
        <td>{{ line.sku }}</td>
        <td>{{ line.quantity }}</td>
        <td><MoneyText :amount="line.unitPrice" /></td>
        <td><MoneyText :amount="line.lineTotal" /></td>
      </tr>
    </tbody>
  </table>
</template>

<script setup lang="ts">
import MoneyText from './MoneyText.vue';
import type { OrderLine } from '../types';

defineProps<{ lines: OrderLine[] }>();
</script>
