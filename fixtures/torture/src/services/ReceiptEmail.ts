import { on } from './bus';
import { PriceService } from './PriceService';
on('order.paid', () => new PriceService().format(1));                             // M4 subscriber
