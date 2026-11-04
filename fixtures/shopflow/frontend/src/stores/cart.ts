import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Product } from '../types';

export interface CartLine {
  sku: string;
  name: string;
  price: number;
  quantity: number;
}

export const useCartStore = defineStore('cart', () => {
  const lines = ref<CartLine[]>([]);
  const count = computed(() => lines.value.reduce((n, l) => n + l.quantity, 0));
  const total = computed(() => lines.value.reduce((sum, l) => sum + l.price * l.quantity, 0));

  function add(product: Product) {
    const existing = lines.value.find((l) => l.sku === product.sku);
    if (existing) {
      existing.quantity += 1;
    } else {
      lines.value.push({ sku: product.sku, name: product.name, price: product.price, quantity: 1 });
    }
  }

  function clear() {
    lines.value = [];
  }

  return { lines, count, total, add, clear };
});
