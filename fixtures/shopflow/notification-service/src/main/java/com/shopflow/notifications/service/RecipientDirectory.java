package com.shopflow.notifications.service;

import com.shopflow.notifications.repository.NotificationRepository;
import org.springframework.stereotype.Component;

/** Who to write to about an order: the address its confirmation went to. */
@Component
public class RecipientDirectory {

    private final NotificationRepository notifications;

    public RecipientDirectory(NotificationRepository notifications) {
        this.notifications = notifications;
    }

    public String forOrder(Long orderId) {
        return notifications.findAll().stream()
            .filter(n -> orderId.equals(n.getOrderId()))
            .map(n -> n.getRecipient())
            .findFirst()
            .orElse(null);
    }
}
