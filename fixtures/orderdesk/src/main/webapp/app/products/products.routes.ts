import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { ProductService } from './product.service';

const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./product-list/product-list').then((m) => m.ProductList),
  },
  {
    path: 'new',
    loadComponent: () => import('./product-edit/product-edit').then((m) => m.ProductEdit),
  },
  {
    path: ':id/edit',
    loadComponent: () => import('./product-edit/product-edit').then((m) => m.ProductEdit),
    resolve: { product: (route: ActivatedRouteSnapshot) => inject(ProductService).get(Number(route.paramMap.get('id'))) },
  },
];

export default routes;
