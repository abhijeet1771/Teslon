<template>
  <nav class="navbar">
    <RouterLink to="/" class="brand">ShopFlow</RouterLink>
    <RouterLink to="/orders">Orders</RouterLink>
    <RouterLink to="/invoices">Invoices</RouterLink>
    <RouterLink to="/products">Products</RouterLink>
    <RouterLink to="/notifications">Notifications</RouterLink>
    <RouterLink to="/orders/new" class="cart">Cart ({{ cart.count }})</RouterLink>
  </nav>
</template>

<script setup lang="ts">
import { useCartStore } from '../stores/cart';

const cart = useCartStore();
</script>
