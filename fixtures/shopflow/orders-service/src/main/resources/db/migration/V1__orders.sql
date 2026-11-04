create table orders (
    id bigserial primary key,
    customer_email varchar(200) not null,
    customer_name varchar(200) not null,
    status varchar(30) not null,
    total numeric(12, 2) not null,
    currency varchar(3) not null,
    created_at timestamp not null,
    payment_failure_reason varchar(500)
);

create table order_lines (
    id bigserial primary key,
    order_id bigint not null references orders (id),
    sku varchar(40) not null,
    product_name varchar(200) not null,
    quantity int not null,
    unit_price numeric(12, 2) not null
);
