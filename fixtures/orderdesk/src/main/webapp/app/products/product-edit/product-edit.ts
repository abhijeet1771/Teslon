import { Component, OnInit, inject, input } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { IProduct } from '../product.model';
import { ProductService } from '../product.service';

@Component({
  selector: 'app-product-edit',
  imports: [ReactiveFormsModule],
  templateUrl: './product-edit.html',
})
export class ProductEdit implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(ProductService);
  private readonly router = inject(Router);
  readonly product = input<IProduct>();

  readonly form = this.fb.group({
    sku: ['', [Validators.required, Validators.maxLength(32)]],
    name: ['', Validators.required],
    price: [0, [Validators.required, Validators.min(0.01)]],
    stock: [0, Validators.min(0)],
    active: [true],
  });

  ngOnInit(): void {
    const p = this.product();
    if (p) {
      this.form.patchValue(p);
    }
  }

  save(): void {
    this.service.save({ ...this.product(), ...this.form.value } as Partial<IProduct>).subscribe(() => this.router.navigateByUrl('/products'));
  }
}
