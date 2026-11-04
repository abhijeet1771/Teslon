package com.orderdesk.service;

import com.orderdesk.domain.Invoice;
import com.orderdesk.domain.Order;
import com.orderdesk.repository.InvoiceRepository;
import com.orderdesk.repository.OrderRepository;
import com.orderdesk.service.event.OrderPlacedEvent;
import java.time.Instant;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

@Service
public class InvoiceService {

    private final InvoiceRepository invoices;
    private final OrderRepository orders;

    public InvoiceService(InvoiceRepository invoices, OrderRepository orders) {
        this.invoices = invoices;
        this.orders = orders;
    }

    @EventListener
    public void onOrderPlaced(OrderPlacedEvent event) {
        Order order = orders.findById(event.orderId()).orElseThrow();
        Invoice invoice = new Invoice();
        invoice.setOrder(order);
        invoice.setNumber("INV-" + order.getId());
        invoice.setIssuedAt(Instant.now());
        invoice.setAmount(order.getTotal());
        invoices.save(invoice);
    }
}
