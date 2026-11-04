package com.orderdesk.web.rest;

import com.orderdesk.config.OrderDeskProperties;
import com.orderdesk.domain.Product;
import com.orderdesk.repository.ProductRepository;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/products")
public class ProductResource {

    private final ProductRepository products;
    private final OrderDeskProperties properties;

    public ProductResource(ProductRepository products, OrderDeskProperties properties) {
        this.products = products;
        this.properties = properties;
    }

    @GetMapping
    public List<Product> list(@RequestParam(defaultValue = "0") int page) {
        return products.findAll(PageRequest.of(page, properties.pageSize(), Sort.by("name"))).getContent();
    }

    @GetMapping("/{id}")
    public ResponseEntity<Product> get(@PathVariable Long id) {
        return ResponseEntity.of(products.findById(id));
    }

    @PostMapping
    public Product create(@Valid @RequestBody Product product) {
        return products.save(product);
    }

    @PutMapping("/{id}")
    public Product update(@PathVariable Long id, @Valid @RequestBody Product product) {
        product.setId(id);
        return products.save(product);
    }
}
