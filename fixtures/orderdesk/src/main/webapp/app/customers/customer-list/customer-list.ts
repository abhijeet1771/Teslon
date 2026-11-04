import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ICustomer } from '../customer.model';
import { CustomerService } from '../customer.service';

@Component({
  selector: 'app-customer-list',
  imports: [RouterLink],
  templateUrl: './customer-list.html',
})
export class CustomerList {
  private readonly service = inject(CustomerService);
  readonly customers = signal<ICustomer[]>([]);

  constructor() {
    this.service.list().subscribe((list) => this.customers.set(list));
  }
}
