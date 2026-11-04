package com.shopflow.orders.messaging;

import com.shopflow.events.PaymentResultMessage;
import com.shopflow.events.Topics;
import com.shopflow.orders.service.OrderService;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class PaymentResultListener {

    private final OrderService orderService;

    public PaymentResultListener(OrderService orderService) {
        this.orderService = orderService;
    }

    @KafkaListener(topics = Topics.PAYMENT_RESULT, groupId = "orders")
    public void onPaymentResult(PaymentResultMessage result) {
        orderService.paymentResult(result);
    }
}
