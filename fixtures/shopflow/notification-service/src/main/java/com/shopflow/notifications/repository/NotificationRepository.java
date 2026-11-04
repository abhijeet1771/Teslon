package com.shopflow.notifications.repository;

import com.shopflow.notifications.domain.Notification;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface NotificationRepository extends JpaRepository<Notification, Long> {

    List<Notification> findTop50ByOrderBySentAtDesc();
}
