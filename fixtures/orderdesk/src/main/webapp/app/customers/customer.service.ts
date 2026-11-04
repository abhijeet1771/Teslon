import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from 'app/core/config/api';
import { ICustomer, NewCustomer } from './customer.model';

@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly http = inject(HttpClient);
  private readonly url = `${API}/customers`;

  list(): Observable<ICustomer[]> {
    return this.http.get<ICustomer[]>(this.url);
  }

  get(id: number): Observable<ICustomer> {
    return this.http.get<ICustomer>(`${this.url}/${id}`);
  }

  create(customer: NewCustomer): Observable<ICustomer> {
    return this.http.post<ICustomer>(this.url, customer);
  }

  update(customer: ICustomer): Observable<ICustomer> {
    return this.http.put<ICustomer>(`${this.url}/${customer.id}`, customer);
  }
}
