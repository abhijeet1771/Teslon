import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from 'app/core/config/api';
import { IDailySales } from './report.model';

@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly http = inject(HttpClient);

  dailySales(day: string): Observable<IDailySales> {
    return this.http.get<IDailySales>(`${API}/reports/daily-sales`, { params: new HttpParams().set('day', day) });
  }
}
