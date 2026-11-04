import { Component, OnInit, inject, input } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { CustomerTier, ICustomer } from '../customer.model';
import { CustomerService } from '../customer.service';

type CustomerForm = {
  name: FormControl<ICustomer['name']>;
  email: FormControl<ICustomer['email']>;
  phone: FormControl<string | null>;
  tier: FormControl<CustomerTier>;
};

@Component({
  selector: 'app-customer-edit',
  imports: [ReactiveFormsModule],
  templateUrl: './customer-edit.html',
})
export class CustomerEdit implements OnInit {
  private readonly service = inject(CustomerService);
  private readonly router = inject(Router);
  readonly customer = input<ICustomer>();

  readonly form = new FormGroup<CustomerForm>({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(80)] }),
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    phone: new FormControl<string | null>(null),
    tier: new FormControl<CustomerTier>('STANDARD', { nonNullable: true }),
  });

  ngOnInit(): void {
    const c = this.customer();
    if (c) {
      this.form.reset({ name: c.name, email: c.email, phone: c.phone ?? null, tier: c.tier });
    }
  }

  save(): void {
    const c = this.customer();
    const value = this.form.getRawValue();
    const call = c ? this.service.update({ ...c, ...value }) : this.service.create(value);
    call.subscribe((saved) => this.router.navigate(['/customers', saved.id]));
  }
}
