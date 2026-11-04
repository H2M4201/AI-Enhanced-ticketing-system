# 1. Goals

Checkout Revamp replaces the current three-page checkout with one page for guests and logged-in shoppers. The fictional shop is "Northwind Goods", an online store for kitchen and home products.

- The checkout must be fast.
- Shoppers see the item total, shipping and tax before they pay.
- Cart-to-order conversion improves for guest shoppers.

Out of scope for this epic: gift cards, subscriptions and marketplace sellers.

# 2. Guest checkout

Guests can check out without creating an account. On one page they enter an email address, a shipping address and a payment method.

## 2.1 Saving a card for later

Guests can save a card for later so that their next purchase is faster.

- Saved cards are stored by the payment provider, never by the shop.
- A "Save this card" checkbox appears below the card fields.

## 2.2 Confirmation email

Guests receive an order confirmation email with the order number and a link to the order status page.

- The email is sent once the order is placed.
- The email contains the item list, the total and the delivery estimate.

# 3. Accounts and saved payment methods

Logged-in shoppers see their saved addresses and saved cards on the checkout page.

## 3.1 Saved addresses

Shoppers can pick one of up to five saved addresses. The default address is preselected.

## 3.2 Saving a card

Only logged-in users can save cards. A guest who wants to reuse a card must create an account first.

- The "Save this card" checkbox is hidden for guests.
- A logged-in user can remove a saved card from the account page.

# 4. Order summary

The order summary stays visible on the right side of the page on desktop and moves above the form on phones.

## 4.1 Totals

- Subtotal is the sum of line items after item discounts.
- Shipping is shown as a fixed amount per order for this release.
- Tax is calculated from the shipping address.

## 4.2 Promotion codes

Shoppers can enter one promotion code. The code is applied before tax is calculated.

# 5. Payments

Card payments go through the payment provider's hosted fields, so card numbers never touch the shop's servers.

- The shop accepts Visa, Mastercard and American Express.
- The shop captures the payment when the order is placed.

# 6. Out of scope for the first release

- Express wallets (other than the card form) are not part of this release.
- Address autocomplete is a later improvement.
- Multi-currency pricing is not part of this release.

# 7. Open questions for the product owner

- Which shipping methods are shown first on the page?
- Do returning guests keep their saved cart for thirty days?
