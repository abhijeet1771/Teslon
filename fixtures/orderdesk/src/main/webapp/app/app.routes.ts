import { Routes } from '@angular/router';
import { adminGuard } from './core/auth/admin.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./dashboard/dashboard').then((m) => m.Dashboard),
    title: 'Dashboard',
  },
  {
    path: 'customers',
    loadChildren: () => import('./customers/customers.routes'),
  },
  {
    path: 'products',
    loadChildren: () => import('./products/products.routes'),
  },
  {
    path: 'orders',
    loadChildren: () => import('./orders/orders.routes'),
  },
  {
    path: 'reports',
    canActivate: [adminGuard],
    loadComponent: () => import('./reports/daily-sales/daily-sales').then((m) => m.DailySales),
    title: 'Reports',
  },
  { path: '**', redirectTo: '' },
];
