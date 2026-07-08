# GuildPay AI — Functional MVP Scope (what the demo must prove)

**Core claim:** a user interacts with GuildPay AI through WhatsApp — completes onboarding, receives a
demo QAR account/wallet reference, initiates a payment by text, voice note, image, or Excel upload,
confirms securely with OTP/PIN, and receives a receipt — all inside WhatsApp.

## Required modules
1. **WhatsApp Entry & Onboarding** — link/QR → language → profile + QID + consent → confirmation.
2. **Demo Account/Wallet Ledger (multi-currency)** — account reference, starting balance, funding, ledger history.
   Two rails behind `PartnerAdapter`: **QAR** on the simulated double-entry ledger, and **NGN** via the
   **Flutterwave sandbox** (virtual accounts + Transfers API; test money only). Currency is chosen at onboarding.
3. **Text Payment Flow** — extract recipient/amount/purpose → confirmation summary.
4. **Voice Note Payment Flow** — transcribe → extract intent → confirm.
5. **Snap-to-Pay** — read bill/invoice/QR/screenshot/account details → confirm.
6. **Excel Bulk Transactions** — validate rows, total, flag errors, batch approval, batch receipt.
7. **OTP/PIN Confirmation** — required for every sensitive action before processing.
8. **Receipts & Transaction History** — receipt per transaction; history retrievable.
9. **AI Support in WhatsApp** — account, funding, failed txn, receipt, QID, security, bulk help.
10. **Admin / Partner Dashboard** — users, ledger, transactions, batches, support, risk/exceptions.

## Excel bulk template columns (§7)
| Column | Required | Validation |
|---|---|---|
| Recipient Name | Yes | Text; not blank |
| Account/Wallet Reference | Yes | Numeric/alphanumeric; accepted format |
| Amount QAR | Yes | Positive; ≤ balance / batch limit |
| Purpose | Recommended | Text; default "General Payment" |
| Reference/Invoice No. | Optional | Text |

## Security rule (non-negotiable)
The AI can PREPARE a transaction but CANNOT complete one without explicit OTP/PIN confirmation.
Controls: OTP/PIN on payments + batch + PIN change + freeze; transaction summary before confirm;
session timeout; per-txn and per-batch limits; audit logs; account freeze; clear error handling.

## Success criteria
Onboard in a few minutes · demo QAR account visible in chat · text payment prepared→OTP→receipt ·
voice note → structured payment · image → payment confirmation · Excel → validated, approved,
receipted batch · AI support answers + retrieves receipts · QID expiry reminder shown ·
dashboard shows users, transactions, batches, support logs.

## Out of scope for the demo
Live money movement (QAR ledger is simulated; NGN uses Flutterwave **sandbox** only — no live
payouts) · full bank/wallet integration · card issuance · international transfers ·
crypto/lending/investments · large biller/merchant network · full mobile apps.
