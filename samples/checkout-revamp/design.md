## Architecture
- The storefront calls the checkout service through the API gateway.
- The checkout service owns carts, orders and totals.
- The payment provider hosts the card fields and holds saved cards.
- The notification service sends confirmation emails.

---
## Checkout flow
- Step one: the shopper confirms the cart and the order summary updates.
- Step two: the shopper enters an email address and a shipping address.
- Step three: the shopper picks a shipping method and a payment method.
- Step four: the shopper places the order and sees the confirmation page.

---
## Payment provider
- Card fields are hosted by the payment provider inside an iframe.
- The checkout service receives a payment token, never a card number.
- Saved cards are referenced by the provider customer id.
- The provider sends webhook events for settled payments.

---
## Data model
- Cart: id, shopper id or guest token, line items, promotion code.
- Order: id, status, totals, shipping address, payment token reference.
- Address: owner id, label, fields, is_default flag.
- Saved card reference: owner id, provider customer id, last four digits, brand.

---
## Notifications
- The order confirmation email is sent after the order is placed.
- The email template is shared with the existing order emails.
- Guests receive the same email as logged-in shoppers.
- Marketing opt-in is stored separately and is not changed by checkout.
