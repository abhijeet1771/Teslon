import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { IOrder } from './order.model';
import { OrderService } from './order.service';

export const orderResolver: ResolveFn<IOrder> = (route) => inject(OrderService).get(Number(route.paramMap.get('id')));
