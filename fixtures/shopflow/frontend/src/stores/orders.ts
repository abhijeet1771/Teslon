import { defineStore } from 'pinia';
import { ordersApi } from '../api/orders';
import type { Order } from '../types';

export const useOrdersStore = defineStore('orders', {
  state: () => ({
    orders: [] as Order[],
    loading: false,
  }),
  getters: {
    open: (state) => state.orders.filter((o) => o.status === 'PLACED' || o.status === 'PAID'),
    revenue: (state) => state.orders.filter((o) => o.status === 'PAID').reduce((sum, o) => sum + Number(o.total), 0),
    latest: (state) => state.orders.slice(0, 5),
  },
  actions: {
    async load() {
      this.loading = true;
      try {
        this.orders = await ordersApi.list();
      } finally {
        this.loading = false;
      }
    },
  },
});
