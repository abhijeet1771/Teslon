import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { MoneyPipe } from '../../shared/money.pipe';
import { StatusBadge } from '../../shared/status-badge/status-badge';
import { OrderService } from '../order.service';

@Component({
  selector: 'app-order-list',
  imports: [RouterLink, DatePipe, MoneyPipe, StatusBadge],
  templateUrl: './order-list.html',
})
export class OrderList {
  private readonly service = inject(OrderService);
  readonly orders = toSignal(this.service.list(), { initialValue: [] });
}
