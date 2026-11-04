create table products (
    id bigserial primary key,
    sku varchar(40) not null unique,
    name varchar(200) not null,
    description text,
    price numeric(12, 2) not null,
    stock int not null default 0,
    active boolean not null default true
);
