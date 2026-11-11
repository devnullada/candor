# Pricing and orders

An HTTP service that prices a cart by a fixed set of rules, and takes orders through a fixed
set of states. All money is in whole cents.

## Running

- The program reads the port from `PORT` and serves HTTP on `127.0.0.1:$PORT` (not every
  interface).
- Nothing is stored: a fresh start has no orders. Order ids are integers given out from 1.
- Every response body is JSON; an error's body is `{"error": "<message>"}`, with any message
  that helps.

## The catalogue

| sku      | price | category |
| -------- | ----- | -------- |
| `apple`  | 50    | fruit    |
| `bread`  | 250   | bakery   |
| `cheese` | 700   | dairy    |
| `milk`   | 120   | dairy    |
| `wine`   | 1500  | alcohol  |

## A quote

`POST /quote` with a cart:

```
{"items": [{"sku": "apple", "qty": 7}, {"sku": "wine", "qty": 1}], "tier": "gold", "coupon": "SAVE10"}
```

- `items` (required): one or more lines; `sku` from the catalogue, `qty` an integer from 1 to
  100. Lines with the same sku are merged first (their quantities added; the total must still be
  at most 100). The quote lists lines in catalogue order (the table above).
- `tier` (optional): `standard` (the default), `silver` or `gold`.
- `coupon` (optional): a code, below.

Each line is priced by these steps, in order. "Half up" rounding is to the nearest cent, a half
going up.

1. **Multi-buy.** `apple`: every third is free (7 apples cost 5 × 50). `bread`: each pair costs
   400 instead of 500 (3 bread cost 400 + 250). Other skus: price × qty. This is the line's
   `gross`.
2. **Tier.** `silver` takes 5% off, `gold` 10%, of each line's gross except `alcohol` lines,
   rounded half up per line.
3. **Line coupon.** `DAIRY20` takes 20% off what is left of each `dairy` line after step 2,
   rounded half up per line.
4. **Tax.** On what is left of each line: `alcohol` 25%, everything else 10%, rounded half up
   per line.

A line's `discount` is steps 2 and 3 together; its `net` is gross − discount; its `tax` is step
4; its `total` is net + tax.

Then for the whole cart: `subtotal` is the sum of the lines' totals. The coupon `SAVE10` takes
1000 off the subtotal if the subtotal is at least 5000 (else it doesn't apply). `total` is
subtotal − that voucher.

Coupons: `DAIRY20` and `SAVE10`. A coupon applies if it changed anything (`DAIRY20` on a cart
with no dairy doesn't). An unknown code: 400.

The answer is 200 and:

```
{
  "lines": [{"sku": "apple", "qty": 7, "gross": 250, "discount": 25, "net": 225, "tax": 23, "total": 248}, ...],
  "subtotal": 2123,
  "voucher": 0,
  "total": 2123,
  "coupon": {"code": "SAVE10", "applied": false}
}
```

`coupon` is null when none was given. An empty `items`, an unknown sku, a `qty` out of range
(after merging too), an unknown tier, a field of the wrong type, or a body that isn't JSON:
400.

## Orders

`POST /orders` with a cart (the same body as a quote) prices it and makes an order: 201 and

```
{"id": 1, "state": "pending", "total": 2123, "history": ["pending"]}
```

A cart that wouldn't quote: 400, and no order is made.

`POST /orders/{id}/{action}` moves an order along, by this table, and answers 200 and the
order (its `history` lists every state it has been in, oldest first):

| From        | `pay`  | `ship`    | `deliver`   | `cancel`    | `refund`   |
| ----------- | ------ | --------- | ----------- | ----------- | ---------- |
| `pending`   | `paid` |           |             | `cancelled` |            |
| `paid`      |        | `shipped` |             |             | `refunded` |
| `shipped`   |        |           | `delivered` |             |            |
| `delivered` |        |           |             |             | `refunded` |

- An action not allowed from the order's state (an empty cell, or any action on `cancelled` or
  `refunded`): 409, and the order doesn't change.
- An action that isn't one of the five: 404.

## Other endpoints

| Request             | Answer                                     |
| ------------------- | ------------------------------------------ |
| `GET /orders/{id}`  | 200 and the order                          |
| `GET /orders`       | 200, `{"orders": [...]}`, every order, by id |

An id in a path that names nothing (including one that isn't an integer): 404. A path that
matches no endpoint: 404. A known path with the wrong method: 405.

## Tests

Write tests in the language's own way for each rule above. They are yours; separate tests,
which you don't see, start the program and send it requests.
