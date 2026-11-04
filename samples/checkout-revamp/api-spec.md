# Checkout API v1 (fictional)

Base path: /api/v1. All requests and responses use JSON. Logged-in shoppers send a bearer token. Guests send a guest token.

## Carts

GET /carts/{cartId}
Returns the cart with line items, item totals and the applied promotion code.

POST /carts/{cartId}/items
Adds an item. Body: productId, quantity.

PATCH /carts/{cartId}/promotion
Applies one promotion code. Body: code. Only one code is accepted per cart.


# Checkout API v1 (continued)

## Totals

POST /carts/{cartId}/quote
Returns subtotal, shipping, tax and grand total for a shipping address.
Tax is computed from the shipping address in the request body.

## Orders

POST /carts/{cartId}/orders
Places the order and captures the payment. Body: email, shippingAddressId or address, shippingMethod, paymentToken.
The response contains the order id, the status and the order status page link.

GET /orders/{orderId}
Returns the order status, line items, totals and the delivery estimate.


# Checkout API v1 (continued)

## Addresses

GET /accounts/me/addresses
Returns up to five saved addresses. The default address has isDefault set to true.

POST /accounts/me/addresses
Creates an address. Body: label, name, street, city, postalCode, country.

## Saved cards

GET /accounts/me/cards
Returns saved cards as a brand, a last-four value and an expiry month and year. Full card numbers are never returned.

DELETE /accounts/me/cards/{cardId}
Removes a saved card from the account. Available to logged-in users only.

## Notifications

POST /internal/notifications/order-confirmation
Called by the checkout service after an order is placed. Body: orderId, recipientEmail, locale.
