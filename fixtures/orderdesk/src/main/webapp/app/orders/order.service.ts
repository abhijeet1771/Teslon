import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from 'app/core/config/api';
import { ICreateOrder, IOrder, IOrderSummary } from './order.model';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);
  private readonly url = API + '/orders';

  list(): Observable<IOrderSummary[]> {
    return this.http.get<IOrderSummary[]>(this.url);
  }

  get(id: number): Observable<IOrder> {
    return this.http.get<IOrder>(`${this.url}/${id}`);
  }

  create(order: ICreateOrder): Observable<IOrder> {
    return this.http.post<IOrder>(this.url, order);
  }

  cancel(id: number): Observable<IOrder> {
    return this.http.post<IOrder>(`${this.url}/${id}/cancel`, {});
  }
}
