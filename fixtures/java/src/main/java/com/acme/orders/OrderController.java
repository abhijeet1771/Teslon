package com.acme.orders;

import com.acme.audit.AuditLog;
import javax.validation.constraints.Size;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private final OrderService service;
  private final AuditLog audit;

  public OrderController(OrderService service, AuditLog audit) {
    this.service = service;
    this.audit = audit;
  }

  @GetMapping("/{id}")
  public OrderDto get(@PathVariable String id) {
    if (id == null) { throw new BadRequestException("id required"); }
    return service.find(id);
  }

  @PostMapping("/{id}/cancel")
  @PreAuthorize("hasRole('ADMIN')")
  public void cancel(@PathVariable String id, @Size(min = 3, max = 200) String reason) throws NotFoundException {
    service.cancel(id, reason);
  }
}
