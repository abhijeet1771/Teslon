package com.shopflow.notifications.web;

import java.time.Instant;

public record NotificationDto(Long id, Long orderId, String recipient, String kind, String subject, Instant sentAt, String status) {}
