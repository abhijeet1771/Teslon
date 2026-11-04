package com.shopflow.notifications.service;

import com.shopflow.events.OrderCancelledMessage;
import com.shopflow.events.OrderPlacedMessage;
import com.shopflow.events.PaymentResultMessage;
import com.shopflow.notifications.domain.Notification;
import com.shopflow.notifications.repository.NotificationRepository;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.MailException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class Mailer {

    private final JavaMailSender mailSender;
    private final NotificationRepository notifications;
    private final String from;

    public Mailer(JavaMailSender mailSender, NotificationRepository notifications, @Value("${shopflow.mail.from}") String from) {
        this.mailSender = mailSender;
        this.notifications = notifications;
        this.from = from;
    }

    @Async
    public void orderConfirmation(OrderPlacedMessage order) {
        String subject = "Your ShopFlow order " + order.orderId();
        String body = "Hello " + order.customerName() + ",\n\nthank you for your order. The total is " + order.total() + " " + order.currency() + ".";
        send(order.orderId(), order.customerEmail(), "ORDER_CONFIRMATION", subject, body);
    }

    @Async
    public void orderCancelled(OrderCancelledMessage order) {
        String subject = "Order " + order.orderId() + " cancelled";
        String body = order.reason() == null ? "Your order was cancelled." : "Your order was cancelled: " + order.reason();
        send(order.orderId(), order.customerEmail(), "ORDER_CANCELLED", subject, body);
    }

    @Async
    public void paymentFailed(PaymentResultMessage result, String recipient) {
        send(result.orderId(), recipient, "PAYMENT_FAILED", "Payment for order " + result.orderId() + " failed", result.failureReason());
    }

    private void send(Long orderId, String to, String kind, String subject, String body) {
        Notification n = new Notification();
        n.setOrderId(orderId);
        n.setRecipient(to);
        n.setKind(kind);
        n.setSubject(subject);
        n.setSentAt(Instant.now());
        try {
            SimpleMailMessage mail = new SimpleMailMessage();
            mail.setFrom(from);
            mail.setTo(to);
            mail.setSubject(subject);
            mail.setText(body);
            mailSender.send(mail);
            n.setStatus("SENT");
        } catch (MailException e) {
            n.setStatus("FAILED");
        }
        notifications.save(n);
    }
}
