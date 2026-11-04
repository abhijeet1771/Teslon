package com.shopflow.billing.messaging;

import com.shopflow.events.PaymentResultMessage;
import com.shopflow.events.Topics;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
public class PaymentResultPublisher {

    private final KafkaTemplate<String, PaymentResultMessage> kafkaTemplate;

    public PaymentResultPublisher(KafkaTemplate<String, PaymentResultMessage> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(PaymentResultMessage result) {
        kafkaTemplate.send(Topics.PAYMENT_RESULT, String.valueOf(result.orderId()), result);
    }
}
