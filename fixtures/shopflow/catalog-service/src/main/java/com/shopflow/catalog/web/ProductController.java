package com.shopflow.catalog.web;

import com.shopflow.catalog.mapper.ProductMapper;
import com.shopflow.catalog.service.ProductService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/products")
public class ProductController {

    private final ProductService productService;
    private final ProductMapper productMapper;

    public ProductController(ProductService productService, ProductMapper productMapper) {
        this.productService = productService;
        this.productMapper = productMapper;
    }

    @GetMapping
    public List<ProductDto> list() {
        return productService.active().stream().map(productMapper::toDto).toList();
    }

    @GetMapping("/{sku}")
    public ProductDto get(@PathVariable String sku) {
        return productMapper.toDto(productService.bySku(sku));
    }

    @PutMapping("/{sku}")
    public ProductDto update(@PathVariable String sku, @Valid @RequestBody ProductUpdateRequest request) {
        return productMapper.toDto(productService.update(sku, request));
    }
}
