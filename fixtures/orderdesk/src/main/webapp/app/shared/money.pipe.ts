import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  transform(value: number | null | undefined, currency = 'EUR'): string {
    return value == null ? '' : new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
  }
}
