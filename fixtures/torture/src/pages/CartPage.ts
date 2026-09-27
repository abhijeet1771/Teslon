import { isOn } from '../services/flags';
import { PriceService } from '../services/PriceService';
export default () => isOn('new-pricing') ? new PriceService().format(2) : 'old';  // M10
