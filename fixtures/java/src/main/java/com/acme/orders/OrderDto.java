package com.acme.orders;

import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.Table;

@Entity
@Table(name = "orders")
public class OrderDto {
  @Column(name = "id") private String id;
  @Column(name = "total_cents") private long totalCents;
  @Column(name = "status") private String status;
}
