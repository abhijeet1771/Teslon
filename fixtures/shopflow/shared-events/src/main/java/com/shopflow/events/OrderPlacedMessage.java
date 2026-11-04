package com.shopflow.events;

import java.math.BigDecimal;
import java.util.List;

/** Published by orders-service on shop.orders.placed when an order is placed. */
public record OrderPlacedMessage(
    Long orderId,
    String customerEmail,
    String customerName,
    BigDecimal total,
    String currency,
    List<Line> lines
) {
    public record Line(String sku, int quantity, BigDecimal unitPrice) {}
}
