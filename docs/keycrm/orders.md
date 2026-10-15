# KeyCRM API: замовлення (за OpenAPI 1.2.0)

- `POST /order`: обов'язкові `source_id` та `buyer` (`full_name`, `phone`; телефон рекомендовано в міжнародному форматі з `+`). `source_uuid` — номер замовлення в джерелі (ми шлемо `quick-<номер>`). Блоки `shipping`, `marketing`, `products`, `payments`, `custom_fields` необов'язкові.
- `shipping`: `delivery_service_id`, `tracking_code`, `shipping_service`, `shipping_address_city/region/zip`, `shipping_receive_point`, `recipient_full_name`, `recipient_phone`, `warehouse_ref` (потребує `delivery_service_id` НП), `shipping_date`.
- `products[]`: `sku`, `name`, `price`, `quantity`, `picture`, `properties[{name,value}]` (обидва поля обов'язкові).
- `payments[]` у замовленні: `amount` обов'язковий, `payment_method_id` або `payment_method`, `status` (`paid`/`not_paid`/`canceled`). Окремо: `POST /order/{id}/payment`.
- `PUT /order/{orderId}`: `status_id`, `buyer_comment`, `manager_comment`, `shipping`, `products`, знижки. Повторне додавання `tracking_code`, коли в замовленні він уже є, дає помилку — тому ми записуємо ТТН один раз (`ttn_crm_synced`).
- `GET /order`: `limit` ≤ 50, `page`, `include`, `sort`, `filter[поле]=значення`. `GET /order/{id}?include=...`.
- Довідники: `/order/status`, `/order/source`, `/order/payment-method`, `/order/delivery-service`.
