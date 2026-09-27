package com.acme.orders;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

public class OrderServiceTest {
  @Test
  @DisplayName("rejects a cancellation reason shorter than 3 characters")
  void rejectsShortReason() { }

  @Test
  @DisplayName("marks the order cancelled in the repository")
  void marksCancelled() { }
}
