import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import { isAdmin } from '../utils/session';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/orders', name: 'orders', component: () => import('../views/OrdersView.vue') },
    { path: '/orders/new', name: 'order-new', component: () => import('../views/NewOrderView.vue') },
    { path: '/orders/:id', name: 'order', component: () => import('../views/OrderDetailView.vue'), props: true },
    { path: '/invoices', name: 'invoices', component: () => import('../views/InvoicesView.vue') },
    { path: '/invoices/:id', name: 'invoice', component: () => import('../views/InvoiceDetailView.vue') },
    { path: '/products', name: 'products', component: () => import('../views/ProductsView.vue') },
    { path: '/products/:sku/edit', name: 'product-edit', component: () => import('../views/ProductEditView.vue'), meta: { requiresAdmin: true } },
    { path: '/notifications', name: 'notifications', component: () => import('../views/NotificationsView.vue') },
  ],
});

router.beforeEach((to) => {
  if (to.meta.requiresAdmin && !isAdmin()) {
    return { name: 'home' };
  }
});

export default router;
