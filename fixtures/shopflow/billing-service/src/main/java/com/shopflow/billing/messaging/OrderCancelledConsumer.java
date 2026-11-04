package com.shopflow.billing.messaging;

import com.shopflow.billing.service.InvoiceService;
import com.shopflow.events.OrderCancelledMessage;
import com.shopflow.events.Topics;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderCancelledConsumer {

    private final InvoiceService invoiceService;

    public OrderCancelledConsumer(InvoiceService invoiceService) {
        this.invoiceService = invoiceService;
    }

    @KafkaListener(topics = Topics.ORDER_CANCELLED, groupId = "billing")
    public void onOrderCancelled(OrderCancelledMessage message) {
        invoiceService.voidFor(message.orderId());
    }
}
