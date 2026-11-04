import { Routes } from '@angular/router';
import { customerResolver } from './customer.resolver';

const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./customer-list/customer-list').then((m) => m.CustomerList),
  },
  {
    path: 'new',
    loadComponent: () => import('./customer-edit/customer-edit').then((m) => m.CustomerEdit),
  },
  {
    path: ':id',
    loadComponent: () => import('./customer-detail/customer-detail').then((m) => m.CustomerDetail),
    resolve: { customer: customerResolver },
  },
  {
    path: ':id/edit',
    loadComponent: () => import('./customer-edit/customer-edit').then((m) => m.CustomerEdit),
    resolve: { customer: customerResolver },
  },
];

export default routes;
