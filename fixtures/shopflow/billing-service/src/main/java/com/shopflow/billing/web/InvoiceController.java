package com.shopflow.billing.web;

import com.shopflow.billing.service.InvoiceService;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/invoices")
public class InvoiceController {

    private final InvoiceService invoiceService;
    private final InvoiceMapper invoiceMapper;

    public InvoiceController(InvoiceService invoiceService, InvoiceMapper invoiceMapper) {
        this.invoiceService = invoiceService;
        this.invoiceMapper = invoiceMapper;
    }

    @GetMapping
    public List<InvoiceDto> list() {
        return invoiceService.list().stream().map(invoiceMapper::toDto).toList();
    }

    @GetMapping("/{id}")
    public ResponseEntity<InvoiceDto> get(@PathVariable Long id) {
        return ResponseEntity.of(invoiceService.get(id).map(invoiceMapper::toDto));
    }

    @GetMapping("/by-order/{orderId}")
    public ResponseEntity<InvoiceDto> forOrder(@PathVariable Long orderId) {
        return ResponseEntity.of(invoiceService.forOrder(orderId).map(invoiceMapper::toDto));
    }
}
