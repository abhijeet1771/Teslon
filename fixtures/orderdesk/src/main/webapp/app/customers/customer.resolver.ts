import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, ResolveFn } from '@angular/router';
import { ICustomer } from './customer.model';
import { CustomerService } from './customer.service';

export const customerResolver: ResolveFn<ICustomer> = (route: ActivatedRouteSnapshot) =>
  inject(CustomerService).get(Number(route.paramMap.get('id')));
