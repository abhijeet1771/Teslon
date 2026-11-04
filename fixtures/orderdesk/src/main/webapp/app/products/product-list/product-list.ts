import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../shared/money.pipe';
import { ProductService } from '../product.service';

@Component({
  selector: 'app-product-list',
  imports: [RouterLink, MoneyPipe],
  templateUrl: './product-list.html',
})
export class ProductList {
  protected readonly service = inject(ProductService);
  readonly products = computed(() => this.service.products.value() ?? []);
}
