package com.orderdesk.web.rest;

import com.orderdesk.domain.Customer;
import com.orderdesk.repository.CustomerRepository;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/customers")
public class CustomerResource {

    private final CustomerRepository customers;

    public CustomerResource(CustomerRepository customers) {
        this.customers = customers;
    }

    @GetMapping
    public List<Customer> list() {
        return customers.findAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<Customer> get(@PathVariable Long id) {
        return ResponseEntity.of(customers.findById(id));
    }

    @PostMapping
    public Customer create(@Valid @RequestBody Customer customer) {
        return customers.save(customer);
    }

    @PutMapping("/{id}")
    public Customer update(@PathVariable Long id, @Valid @RequestBody Customer customer) {
        customer.setId(id);
        return customers.save(customer);
    }
}
