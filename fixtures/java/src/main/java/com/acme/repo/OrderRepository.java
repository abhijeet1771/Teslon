package com.acme.repo;

import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {
  public Object findById(String id) { return null; }
  public void markCancelled(String id) { }
}
