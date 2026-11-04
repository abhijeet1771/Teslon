import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from 'app/core/config/api';
import { IProduct } from './product.model';

@Injectable({ providedIn: 'root' })
export class ProductService {
  private readonly http = inject(HttpClient);
  private readonly url = `${API}/products`;
  readonly page = signal(0);
  readonly products = httpResource<IProduct[]>(() => `${this.url}?page=${this.page()}`);

  get(id: number): Observable<IProduct> {
    return this.http.get<IProduct>(`${this.url}/${id}`);
  }

  save(product: Partial<IProduct>): Observable<IProduct> {
    return product.id ? this.http.put<IProduct>(`${this.url}/${product.id}`, product) : this.http.post<IProduct>(this.url, product);
  }
}
