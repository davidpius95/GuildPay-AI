# GuildPay AI — Functional MVP Scope (what the demo must prove)

> See `docs/00_VISION_AND_ARCHITECTURE.md` for the vision and architecture this scope serves.

**Core claim:** a user runs a **full wallet / neobank entirely inside WhatsApp** — creates a virtual
account, funds it, and by **natural-language text, voice note, or photo** does everyday money actions
(send money, transfer to a bank, buy airtime/data, pay bills, save), confirming each with **OTP/PIN**
and receiving a **receipt** — no app, no forms. Same category as **Xara** (usexara.ai).

**Markets (co-equal):** **Nigeria (NGN)** — flagship, Flutterwave sandbox, full feature set; and
**Qatar (QAR)** — simulated ledger, wallet + transfers subset. Currency chosen at onboarding.

**Money model:** sandbox / simulated **test money only**, architected **real-ready** (see Vision §3).

## Required capabilities (each = one module; all OTP/PIN-gated, currency-aware)

1. **Onboarding & virtual account** — language (EN/Pidgin/AR) → profile → KYC id (BVN for NGN, QID for
   QAR) → consent → **virtual account/wallet created** and shown in chat.
2. **Fund wallet** — NGN: inbound to the virtual NUBAN detected via Flutterwave webhook; QAR: simulated
   credit. Balance updates + funding receipt.
3. **Balance & history** — "what's my balance", "show my last transactions", statement retrieval.
4. **Send to GuildPay user (P2P)** — resolve recipient → confirm → OTP/PIN → transfer → receipts to both.
5. **Transfer to any bank (NIP)** *(NGN)* — extract bank + account no + amount → **name enquiry** →
   confirm the resolved name → OTP/PIN → payout → receipt.
6. **Buy airtime / data** *(NGN)* — network + phone + amount/plan → confirm → OTP/PIN → vend → receipt.
7. **Pay bills** *(NGN)* — electricity / cable TV / betting: biller + customer id → **validate customer**
   → confirm → OTP/PIN → pay → token/receipt.
8. **Savings / target-savings** *(NGN)* — create a goal, move funds in/out (sub-ledger), see progress.
9. **Request money** — generate a request/payment link or prompt another user to pay.
10. **Multimodal input** — the above work from **text, voice note (Whisper), or photo (Claude vision:
    invoice / bank details / meter number / screenshot)**.
11. **Spending insights** — categorized summary ("how much did I spend on airtime this week").
12. **AI support in WhatsApp** — account, funding, failed txn, receipts, limits, security, KYC help.
13. **Admin / partner dashboard** — users, wallets/ledger, transactions, bills/airtime, savings,
    support, risk/exceptions, demo reset.

## Security rule (non-negotiable)
The AI can **PREPARE** any transaction but **CANNOT complete** one without explicit **OTP/PIN**.
Only the OTP/PIN verifier moves `pending_otp → completed`. Test `no-otp-no-money` covers **every**
capability and **both** rails. Controls: transaction summary before confirm; name-enquiry before bank
payout; per-txn & daily limits; new-beneficiary cool-off; session timeout; account freeze; audit logs.

## Success criteria (demo must show)
Onboard + virtual account visible in chat · fund wallet · balance/history on request · P2P transfer →
OTP → receipts · **bank transfer with name enquiry** → OTP → receipt · **airtime/data purchase** →
receipt · **bill payment** (e.g. electricity token) → receipt · create a savings goal & fund it ·
request money · all of the above driven by **text, a voice note, and a photo** · AI support answers +
retrieves a receipt · QAR market shows wallet + P2P + transfer on the simulated ledger · dashboard
shows users, transactions, bills, savings, support logs.

## Out of scope for the demo
Live money movement (NGN = Flutterwave **sandbox**; QAR = simulated) · licensed bank/PSSP integration ·
virtual/physical cards · crypto/lending/investments · international transfers · full mobile apps.
