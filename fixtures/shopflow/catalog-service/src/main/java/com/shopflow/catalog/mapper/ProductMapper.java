package com.shopflow.catalog.mapper;

import com.shopflow.catalog.domain.Product;
import com.shopflow.catalog.web.ProductDto;
import com.shopflow.catalog.web.ProductUpdateRequest;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;

@Mapper(componentModel = "spring")
public interface ProductMapper {

    @Mapping(target = "inStock", expression = "java(product.getStock() > 0)")
    ProductDto toDto(Product product);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "sku", ignore = true)
    @Mapping(target = "active", ignore = true)
    void update(ProductUpdateRequest request, @MappingTarget Product product);
}
