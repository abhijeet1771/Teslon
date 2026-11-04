import { Component, input } from '@angular/core';
import { OrderStatus } from '../../orders/order.model';

@Component({
  selector: 'app-status-badge',
  template: `
    @switch (status()) {
      @case ('NEW') { <span class="badge new">New</span> }
      @case ('PAID') { <span class="badge paid">Paid</span> }
      @case ('SHIPPED') { <span class="badge shipped">Shipped</span> }
      @case ('CANCELLED') { <span class="badge cancelled">Cancelled</span> }
    }
  `,
  styles: [
    `
      .badge { padding: 2px 8px; border-radius: 10px; font-size: 12px; }
      .paid { background: #e3f1e5; }
      .cancelled { background: #fcebe9; }
    `,
  ],
})
export class StatusBadge {
  readonly status = input.required<OrderStatus>();
}
