import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-confirm-dialog',
  template: `
    <div class="dialog">
      <p>{{ message() }}</p>
      <button type="button" (click)="confirmed.emit()">Yes</button>
      <button type="button" (click)="cancelled.emit()">No</button>
    </div>
  `,
})
export class ConfirmDialog {
  readonly message = input('Are you sure?');
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
}
