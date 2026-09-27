package com.acme.orders;

import com.acme.repo.OrderRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {
  private final OrderRepository repository;
  public OrderService(OrderRepository repository) { this.repository = repository; }

  public OrderDto find(String id) { return repository.findById(id); }

  @Transactional
  public void cancel(String id, String reason) {
    if (reason.length() < 3) { throw new IllegalArgumentException("reason too short"); }
    repository.markCancelled(id);
  }
}
