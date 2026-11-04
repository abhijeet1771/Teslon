package com.orderdesk.service;

import com.orderdesk.domain.Customer;
import com.orderdesk.domain.CustomerTier;
import com.orderdesk.domain.OrderItem;
import com.orderdesk.domain.Product;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class PricingService {

    public BigDecimal lineTotal(Product product, int quantity) {
        return product.getPrice().multiply(BigDecimal.valueOf(quantity));
    }

    public BigDecimal orderTotal(Customer customer, List<OrderItem> items) {
        BigDecimal sum = items.stream()
            .map(i -> i.getUnitPrice().multiply(BigDecimal.valueOf(i.getQuantity())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        if (customer.getTier() == CustomerTier.GOLD) {
            sum = sum.multiply(new BigDecimal("0.95"));
        }
        return sum.setScale(2, RoundingMode.HALF_UP);
    }
}
