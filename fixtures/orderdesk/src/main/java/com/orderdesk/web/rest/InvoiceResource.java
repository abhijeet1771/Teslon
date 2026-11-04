package com.orderdesk.web.rest;

import com.orderdesk.domain.Invoice;
import com.orderdesk.repository.InvoiceRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/invoices")
public class InvoiceResource {

    private final InvoiceRepository invoices;

    public InvoiceResource(InvoiceRepository invoices) {
        this.invoices = invoices;
    }

    @GetMapping
    public ResponseEntity<Invoice> byOrder(@RequestParam Long orderId) {
        return ResponseEntity.of(invoices.findByOrderId(orderId));
    }
}
