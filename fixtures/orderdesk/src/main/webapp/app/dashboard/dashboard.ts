import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { MoneyPipe } from '../shared/money.pipe';
import { StatusBadge } from '../shared/status-badge/status-badge';
import { OrderService } from '../orders/order.service';
import { ProductService } from '../products/product.service';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, MoneyPipe, StatusBadge],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  private readonly products = inject(ProductService);
  readonly recent = toSignal(inject(OrderService).list(), { initialValue: [] });
  readonly lowStock = computed(() => (this.products.products.value() ?? []).filter((p) => p.stock < 5));
}
