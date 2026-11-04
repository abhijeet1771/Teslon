package com.shopflow.catalog.messaging;

import com.shopflow.catalog.service.ProductService;
import com.shopflow.events.OrderPlacedMessage;
import com.shopflow.events.Topics;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/** Takes the ordered quantities off stock when an order is placed. */
@Component
public class StockReservationListener {

    private final ProductService productService;

    public StockReservationListener(ProductService productService) {
        this.productService = productService;
    }

    @KafkaListener(topics = Topics.ORDER_PLACED, groupId = "catalog")
    public void onOrderPlaced(OrderPlacedMessage message) {
        for (OrderPlacedMessage.Line line : message.lines()) {
            productService.reserve(line.sku(), line.quantity());
        }
    }
}
