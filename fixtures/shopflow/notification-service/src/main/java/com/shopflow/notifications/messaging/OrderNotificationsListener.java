package com.shopflow.notifications.messaging;

import com.shopflow.events.OrderCancelledMessage;
import com.shopflow.events.OrderPlacedMessage;
import com.shopflow.events.Topics;
import com.shopflow.notifications.service.Mailer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderNotificationsListener {

    private final Mailer mailer;

    public OrderNotificationsListener(Mailer mailer) {
        this.mailer = mailer;
    }

    @KafkaListener(topics = {Topics.ORDER_PLACED, Topics.ORDER_CANCELLED}, groupId = "notifications")
    public void onOrderEvent(ConsumerRecord<String, Object> record) {
        if (record.value() instanceof OrderPlacedMessage placed) {
            mailer.orderConfirmation(placed);
        } else if (record.value() instanceof OrderCancelledMessage cancelled) {
            mailer.orderCancelled(cancelled);
        }
    }
}
