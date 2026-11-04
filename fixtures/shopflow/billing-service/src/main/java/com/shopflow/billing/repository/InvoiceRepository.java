package com.shopflow.billing.repository;

import com.shopflow.billing.domain.Invoice;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface InvoiceRepository extends JpaRepository<Invoice, Long> {

    Optional<Invoice> findByOrderId(Long orderId);

    List<Invoice> findAllByOrderByIssuedAtDesc();
}
