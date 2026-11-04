package com.orderdesk.service;

import com.orderdesk.domain.Product;
import com.orderdesk.service.event.OrderPlacedEvent;
import java.util.List;
import org.springframework.context.event.EventListener;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;

@Service
public class NotificationService {

    private final JavaMailSender mail;

    public NotificationService(JavaMailSender mail) {
        this.mail = mail;
    }

    @EventListener
    public void onOrderPlaced(OrderPlacedEvent event) {
        SimpleMailMessage message = new SimpleMailMessage();
        message.setTo("sales@orderdesk.example");
        message.setSubject("New order " + event.orderId());
        message.setText("Order " + event.orderId() + " was placed.");
        mail.send(message);
    }

    public void lowStock(List<Product> products) {
        SimpleMailMessage message = new SimpleMailMessage();
        message.setTo("warehouse@orderdesk.example");
        message.setSubject(products.size() + " products are low on stock");
        message.setText(String.join("\n", products.stream().map(p -> p.getSku() + " " + p.getStock()).toList()));
        mail.send(message);
    }
}
