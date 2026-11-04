import { Routes } from '@angular/router';
import { orderResolver } from './order.resolver';

const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./order-list/order-list').then((m) => m.OrderList),
  },
  {
    path: 'new',
    loadComponent: () => import('./order-create/order-create').then((m) => m.OrderCreate),
  },
  {
    path: ':id',
    loadComponent: () => import('./order-detail/order-detail').then((m) => m.OrderDetail),
    resolve: { order: orderResolver },
  },
];

export default routes;
