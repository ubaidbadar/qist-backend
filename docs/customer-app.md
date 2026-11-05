# Customer Android API

All endpoints use the existing `/api/v1` JSON envelopes, shared Zod validation, controller/router layout, errors, and password hashing. Customer identities and JWT audience are separate from staff users and enrolled devices. No existing portal endpoint changes its response.

## Account setup and recovery

A retailer first registers the customer's phone through the existing Customers flow. The customer uses **Set / forgot password** in Android to request a WhatsApp authentication code, then submits that code and a new password. Ordinary login uses phone and password; it does not send a code.

Phone numbers normalize to `03XXXXXXXXX`. The verified phone identity can see its matching customer records across active retailers. Only authorized contract fields are returned; no CNIC, guarantors, internal notes, inventory cost, staff credentials, or device-enrollment credentials are exposed. Retailers must keep customer phone ownership accurate; changing a registered number changes which verified phone may access that record.

| Method and path under `/customer-app` | Request | Result |
| --- | --- | --- |
| POST `/auth/forgot-password` | `{phone}` | Generic confirmation; code sent only for a registered phone at an active retailer |
| POST `/auth/reset-password` | `{phone,code,password}` | Set first password or reset; consumes code and revokes all customer sessions |
| POST `/auth/login` | `{phone,password}` | `{accessToken,expiresAt}` |
| GET `/overview?contractId=...` | Bearer customer token; optional selected plan | Profile, available plans, selected plan with schedule/contact/status, first payment page, server Pakistan date |
| GET `/payments?contractId=...&cursor=...` | Bearer customer token; owned plan | Next page of 20 non-voided payments |
| POST `/auth/logout` | Bearer customer token | Revokes that device's session |

Money is integer **paisa**. `totalPayable` excludes the down payment; remaining is `totalPayable + lateFees - paidTotal`. Installments expose their actual amounts, paid amounts, late fees, and statuses. The app must not assume equal monthly installments or calculate paid status from row position. Device lock state is the last acknowledged state, not a promise of real-time connectivity.

## Query and security boundaries

Overview and payment pagination each run **one aggregation** rooted at `customer_accounts`. That aggregate validates session id, expiry, and password version, then joins only phone-owned records at active retailers. Every nested contract/payment/device/branch join matches retailer id as well as its record id. Payment rows are cursor-paginated and voided receipts are omitted.

Authentication is intentionally not a single database command: an Argon2 password must be verified outside MongoDB before a conditional session write. Reset requests similarly need registered-phone lookup, an atomic challenge write, and delivery. Reset verification uses an atomic attempt claim followed by a conditional password update. These necessary writes prevent password-reset/login races and code reuse; they are not redundant refetches.

JWTs have audience `qist-customer`, last 30 days, and are checked against at most five active sessions on every read. A password reset increments token version and clears sessions. IP limits reuse the existing rate limiter. Codes expire after five minutes, allow five guesses, are HMAC-hashed at rest, and have a one-minute resend cooldown and five-send hourly cap per phone. Responses never contain codes; the in-memory outbox exists only in tests. Failed Meta requests return `SERVICE_UNAVAILABLE` and expire the undelivered challenge.

## WhatsApp configuration

Set these in the backend service environment, never in Android or GitHub source:

```dotenv
WHATSAPP_ACCESS_TOKEN=<Meta system-user access token>
WHATSAPP_PHONE_NUMBER_ID=<business sender phone-number id>
WHATSAPP_AUTH_TEMPLATE=<approved AUTHENTICATION copy-code template name>
WHATSAPP_TEMPLATE_LANGUAGE=en_US
WHATSAPP_GRAPH_VERSION=<supported version from your Meta app, e.g. vXX.0>
```

Use a Meta **authentication** template with a copy-code OTP button and five-minute expiry. The backend sends the same code in the body parameter and URL-button parameter. Use the language actually approved for that template. Test with a phone allowed by the Meta sender configuration before distributing. API acceptance is not proof of handset delivery; Meta delivery status/webhooks are separate. There is no console/demo-code fallback outside tests.

References: [Meta's template example](https://www.postman.com/meta/whatsapp-business-platform/request/6vkv46u/create-authentication-template-w-otp-copy-code-button), [Meta's send-template endpoint](https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive).

The optional settings do not stop the existing portal/locker service starting. Until configured, customer code requests return a clear 503. The app's new privacy disclosures and Google Play Data safety must reflect real login and backend data before rollout; the old “no data collected / offline demo” declaration no longer applies.

## Verification

`bun run check` runs typecheck, lint, and tests. Without `MONGODB_URI`, integration tests explicitly skip. The Customer API integration workflow starts an isolated MongoDB replica set and runs all tests without production credentials. Tests cover WhatsApp setup, audience isolation, tenant/phone ownership, suspended retailers, empty accounts, code expiry/attempt limits/cooldown/reuse, concurrent reset, logout, money units, private-field exclusions, one-aggregate reads, and payment pagination.
