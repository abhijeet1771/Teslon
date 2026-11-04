package com.shopflow.billing.service;

import com.shopflow.billing.domain.Invoice;
import com.shopflow.events.OrderPlacedMessage;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Builds the invoice for a placed order: the order total is net, tax is added on top. */
@Component
public class InvoiceFactory {

    private final BigDecimal taxRate;

    public InvoiceFactory(@Value("${billing.tax-rate}") BigDecimal taxRate) {
        this.taxRate = taxRate;
    }

    public Invoice from(OrderPlacedMessage order) {
        BigDecimal net = order.total();
        BigDecimal tax = net.multiply(taxRate).setScale(2, RoundingMode.HALF_UP);
        return Invoice.builder()
            .orderId(order.orderId())
            .number("INV-" + order.orderId())
            .customerEmail(order.customerEmail())
            .net(net)
            .tax(tax)
            .gross(net.add(tax))
            .currency(order.currency())
            .issuedAt(Instant.now())
            .build();
    }
}
