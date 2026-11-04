package com.shopflow.notifications.messaging;

import com.shopflow.events.PaymentResultMessage;
import com.shopflow.notifications.service.Mailer;
import com.shopflow.notifications.service.RecipientDirectory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class PaymentFailedListener {

    private final Mailer mailer;
    private final RecipientDirectory recipients;

    public PaymentFailedListener(Mailer mailer, RecipientDirectory recipients) {
        this.mailer = mailer;
        this.recipients = recipients;
    }

    @KafkaListener(topics = "${shopflow.topics.payments}", groupId = "notifications")
    public void onPaymentResult(PaymentResultMessage result) {
        if (!result.paid()) {
            mailer.paymentFailed(result, recipients.forOrder(result.orderId()));
        }
    }
}
