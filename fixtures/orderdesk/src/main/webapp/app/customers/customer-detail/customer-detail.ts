import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ICustomer } from '../customer.model';

@Component({
  selector: 'app-customer-detail',
  imports: [RouterLink],
  template: `
    @if (customer(); as c) {
      <h2>{{ c.name }}</h2>
      <dl>
        <dt>Email</dt>
        <dd>{{ c.email }}</dd>
        <dt>Phone</dt>
        <dd>{{ c.phone ?? '—' }}</dd>
        <dt>Tier</dt>
        <dd>{{ c.tier }}</dd>
      </dl>
      <a [routerLink]="['/customers', c.id, 'edit']">Edit</a>
    }
  `,
})
export class CustomerDetail {
  readonly customer = input<ICustomer>();
}
