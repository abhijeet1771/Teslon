package com.shopflow.notifications.web;

import com.shopflow.notifications.repository.NotificationRepository;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/notifications")
public class NotificationController {

    private final NotificationRepository notifications;

    public NotificationController(NotificationRepository notifications) {
        this.notifications = notifications;
    }

    @GetMapping
    public List<NotificationDto> recent() {
        return notifications.findTop50ByOrderBySentAtDesc().stream()
            .map(n -> new NotificationDto(n.getId(), n.getOrderId(), n.getRecipient(), n.getKind(), n.getSubject(), n.getSentAt(), n.getStatus()))
            .toList();
    }
}
