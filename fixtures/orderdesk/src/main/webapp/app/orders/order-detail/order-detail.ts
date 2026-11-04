import { Component, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ConfirmDialog } from '../../shared/confirm-dialog/confirm-dialog';
import { MoneyPipe } from '../../shared/money.pipe';
import { StatusBadge } from '../../shared/status-badge/status-badge';
import { IOrder } from '../order.model';
import { OrderService } from '../order.service';

@Component({
  selector: 'app-order-detail',
  imports: [RouterLink, DatePipe, MoneyPipe, StatusBadge, ConfirmDialog],
  templateUrl: './order-detail.html',
})
export class OrderDetail {
  private readonly service = inject(OrderService);
  readonly order = input.required<IOrder>();
  readonly confirming = signal(false);
  readonly current = signal<IOrder | null>(null);

  cancel(): void {
    this.service.cancel(this.order().id).subscribe((o) => {
      this.current.set(o);
      this.confirming.set(false);
    });
  }
}
