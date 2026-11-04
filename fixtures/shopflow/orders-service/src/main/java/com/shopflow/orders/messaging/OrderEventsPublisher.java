package com.shopflow.orders.messaging;

import com.shopflow.events.OrderCancelledMessage;
import com.shopflow.events.OrderPlacedMessage;
import com.shopflow.events.Topics;
import com.shopflow.orders.domain.Order;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
public class OrderEventsPublisher {

    private final KafkaTemplate<String, Object> kafkaTemplate;

    public OrderEventsPublisher(KafkaTemplate<String, Object> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void orderPlaced(Order order) {
        OrderPlacedMessage message = new OrderPlacedMessage(
            order.getId(),
            order.getCustomerEmail(),
            order.getCustomerName(),
            order.getTotal(),
            order.getCurrency(),
            order.getLines().stream().map(l -> new OrderPlacedMessage.Line(l.getSku(), l.getQuantity(), l.getUnitPrice())).toList()
        );
        kafkaTemplate.send(Topics.ORDER_PLACED, String.valueOf(order.getId()), message);
    }

    public void orderCancelled(Order order, String reason) {
        kafkaTemplate.send(Topics.ORDER_CANCELLED, String.valueOf(order.getId()), new OrderCancelledMessage(order.getId(), order.getCustomerEmail(), reason));
    }
}
