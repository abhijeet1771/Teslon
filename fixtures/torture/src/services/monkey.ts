import { PriceService } from './PriceService';
(PriceService.prototype as any).format = function () { return 'patched'; };       // M14 prototype patch
