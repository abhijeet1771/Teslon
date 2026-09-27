package com.acme.audit;

import org.springframework.stereotype.Component;

@Component
public class AuditLog {
  public void write(String message) { }
}
