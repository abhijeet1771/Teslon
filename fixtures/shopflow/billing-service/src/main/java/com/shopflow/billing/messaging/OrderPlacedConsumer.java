package com.shopflow.billing.messaging;

import com.shopflow.billing.service.InvoiceService;
import com.shopflow.events.OrderPlacedMessage;
import com.shopflow.events.Topics;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderPlacedConsumer {

    private static final Logger log = LoggerFactory.getLogger(OrderPlacedConsumer.class);

    private final InvoiceService invoiceService;

    public OrderPlacedConsumer(InvoiceService invoiceService) {
        this.invoiceService = invoiceService;
    }

    @KafkaListener(topics = Topics.ORDER_PLACED, groupId = "billing")
    public void onOrderPlaced(OrderPlacedMessage message) {
        log.info("Invoicing order {}", message.orderId());
        invoiceService.invoiceAndCharge(message);
    }
}
