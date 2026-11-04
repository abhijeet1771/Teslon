import { Component, inject, signal } from '@angular/core';
import { MoneyPipe } from '../../shared/money.pipe';
import { IDailySales } from '../report.model';
import { ReportService } from '../report.service';

@Component({
  selector: 'app-daily-sales',
  imports: [MoneyPipe],
  templateUrl: './daily-sales.html',
})
export class DailySales {
  private readonly reports = inject(ReportService);
  readonly day = signal(new Date().toISOString().slice(0, 10));
  readonly sales = signal<IDailySales | null>(null);

  load(): void {
    this.reports.dailySales(this.day()).subscribe((s) => this.sales.set(s));
  }
}
