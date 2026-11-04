import { Component, inject } from '@angular/core';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { CustomerService } from '../../customers/customer.service';
import { ProductService } from '../../products/product.service';
import { OrderService } from '../order.service';

@Component({
  selector: 'app-order-create',
  imports: [ReactiveFormsModule],
  templateUrl: './order-create.html',
})
export class OrderCreate {
  private readonly orders = inject(OrderService);
  private readonly router = inject(Router);
  protected readonly products = inject(ProductService);
  readonly customers = toSignal(inject(CustomerService).list(), { initialValue: [] });

  readonly form = new FormGroup({
    customerId: new FormControl<number | null>(null, Validators.required),
    lines: new FormArray([this.line()]),
    note: new FormControl('', Validators.maxLength(500)),
  });

  line(): FormGroup {
    return new FormGroup({
      productId: new FormControl<number | null>(null, Validators.required),
      quantity: new FormControl(1, [Validators.min(1), Validators.max(99)]),
    });
  }

  addLine(): void {
    this.form.controls.lines.push(this.line());
  }

  submit(): void {
    const v = this.form.getRawValue();
    this.orders
      .create({ customerId: v.customerId!, lines: v.lines.map((l: { productId: number; quantity: number }) => l), note: v.note ?? undefined })
      .subscribe((o) => this.router.navigate(['/orders', o.id]));
  }
}
