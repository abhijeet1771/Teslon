import { PriceService } from '../services/PriceService';
export default () => new PriceService().format(100);
