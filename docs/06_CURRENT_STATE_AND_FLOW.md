# GuildPay AI — Current State & End-to-End Flow (as-built)

> **Purpose:** a truthful snapshot of how the system works **right now**, derived from the code in
> `apps/api` — not the aspirational spec. It shows exactly what happens when a customer messages,
> which paths are live, which are built-but-unwired, and what remains for a complete end-to-end MVP.
>
> Last verified against `main` @ commit `b24b5e3` (P0 NGN rail live: NUBAN provisioning,
> funding-webhook credit, bank transfer/NIP; voice notes wired).
> Companion to `04_BUILD_PLAN.md` (the checklist) and `05_SETUP_AND_DEPLOY.md` (ops/keys).

---

## 1. What runs today, in one paragraph

A customer messages the GuildPay WhatsApp number. Meta delivers the message to
`POST /webhooks/whatsapp`, which verifies the signature, acknowledges Meta instantly, and processes
in the background. A **deterministic onboarding state machine** walks a first-time user through
language → name → market/currency → KYC id → consent, then creates a wallet row. Once onboarded, a
**message router** handles the user: a pending OTP or Confirm/Cancel is resolved **without the LLM**;
otherwise free text goes to an **LLM intent parser** that returns validated JSON. Today the router can
**check balance**, **add demo funds**, run a **full P2P transfer**, and — via the **live NGN rail** —
provision a **real NUBAN at onboarding**, **credit deposits** that land in it (funding webhook), and
send a **bank transfer (NIP)** to any bank (name enquiry → OTP → payout → auto-refund on failure).
**Voice notes** are transcribed (Groq/Deepgram) and flow through the same intent pipeline. Every money
move is OTP-gated and recorded on the internal Postgres double-entry ledger; the Flutterwave adapter
settles the external NGN legs. Free text that isn't an action falls back to an AI chat reply.

---

## 2. Architecture at a glance

```
WhatsApp user
     │  (text / button tap)
     ▼
Meta WhatsApp Cloud API
     │  HTTPS POST (X-Hub-Signature-256)
     ▼
Cloudflare Tunnel ──► Traefik ──► NestJS API  (guildpay.guildserver.io)
                                     │
      ┌──────────────────────────────┼───────────────────────────────┐
      ▼                              ▼                                ▼
 WhatsappController          OnboardingService                 MessageRouter
 (verify sig, ack,           (state machine:                   (onboarded users:
  background process)         lang→name→market→                 OTP/confirm = deterministic;
      │                       kyc→consent→wallet)               free text → Orchestrator)
      │                                                              │
      │                         ┌────────────────────┬──────────────┤
      ▼                         ▼                    ▼              ▼
 ChannelAdapter          OrchestratorService    TransferService  AiService.chat
 (MetaCloud / Twilio)    (LLM intent → JSON)    (P2P: prepare→   (fallback reply)
      │                         │                 OTP→ledger)
      │                         ▼                    │
      │                    AiService  ───► Groq ─(fallback)─► Gemini
      ▼                                              ▼
 outbound WhatsApp msg                          WalletService + OtpService
                                                     │
                                                     ▼
                                          Postgres (Supabase)  ◄── AuditRepository
                                          wallets · ledger_entries ·
                                          transactions · otp_challenges ·
                                          users · audit_events
```

The **NGN rail is now on the live path**: `PartnerService → FlutterwavePartnerAdapter` provisions
NUBANs, resolves names, and settles NIP payouts; `POST /webhooks/flutterwave` credits funding +
reconciles payouts. Still off-path: `MockPartnerAdapter (QAR)` and `BillsService → FlutterwaveBillsAdapter`.

---

## 3. Component status map

| Layer | Component | File | Status |
|---|---|---|---|
| Ingress | WhatsApp webhook (verify + sig + async) | `webhooks/whatsapp.controller.ts` | ✅ Live |
| Channel | Meta Cloud adapter (send, typing, parse) | `channel/meta-cloud.adapter.ts` | ✅ Live |
| Channel | Twilio sandbox adapter (fallback) | `channel/twilio-sandbox.adapter.ts` | ✅ Present |
| Onboarding | State machine → wallet creation | `onboarding/onboarding.service.ts` | ✅ Live (KYC = format-only) |
| Routing | Onboarded-user router | `banking/message-router.service.ts` | ✅ Live |
| AI | Intent parser (zod-validated) | `banking/orchestrator.service.ts` | ✅ Live (balance/fund/p2p/**bank_transfer**/support) |
| AI | Multi-provider fallback (Groq→Gemini) | `ai/ai.service.ts` | ✅ Live |
| Voice | STT (Groq/Deepgram) → intent pipeline | `stt/*`, `webhooks/whatsapp.controller.ts` | ✅ Live |
| Money | Double-entry ledger (credit/debit/transfer) | `banking/wallet.service.ts` | ✅ Live |
| Money | OTP gate (hashed, Postgres) | `banking/otp.service.ts` | ✅ Live |
| Money | P2P transfer flow | `banking/transfer.service.ts` | ✅ Live |
| Money | Bank transfer (NIP) flow | `banking/bank-transfer.service.ts` | ✅ Live |
| NGN rail | Flutterwave partner adapter | `partner/flutterwave-partner.adapter.ts` | ✅ Live (NUBAN, name enquiry, NIP, verify) |
| NGN rail | Funding + payout webhook | `webhooks/flutterwave.controller.ts` | ✅ Live (credit + reconcile, idempotent) |
| Data | Postgres repos (users/wallets/txns/audit) | `database/*.repository.ts` | ✅ Live |
| Data | Schema migrations | `supabase/migrations/*.sql` | ✅ Applied |
| QAR rail | Mock partner adapter | `partner/mock-partner.adapter.ts` | ⛔ Stub (QAR onboarding/P2P work ledger-only) |
| Bills | Flutterwave bills adapter | `bills/flutterwave-bills.adapter.ts` | ⛔ Stub (P1) |
| Vision | Snap-to-pay (invoice/QR → action) | — | ⛔ Not started (P2) |
| Savings | Target savings sub-ledger | — | ⛔ Not started (P2) |
| Dashboard | Next.js admin | `apps/dashboard/app/*` | ⛔ Skeleton only (P3) |
| Support | AI support agent | — | ⛔ Not started (P3) |

Legend: ✅ works end-to-end · 🟡 code exists but nothing calls it / partial · ⛔ stub or absent.

---

## 4. The flows that work end-to-end today

### 4.1 First contact → onboarding (no LLM)
Deterministic; state persists in `users.onboarding_step` so it survives restarts.

```
User: "hi"
 → users.create(waPhone); audit: onboarding_started
 → "Which language?"         [English] [Pidgin] [العربية]     (step: language)
User taps English
 → "What's your full name?"                                   (step: name)
User: "Ada Obi"
 → "Which country is your wallet in?" [🇳🇬 NGN] [🇶🇦 QAR]      (step: market)
User taps Nigeria
 → "Enter your 11-digit BVN"                                  (step: kyc)
User: "12345678901"   (validated FORMAT ONLY — not verified with any provider)
 → "Agree to Terms? Create wallet now?" [I agree ✅] [Cancel]  (step: consent)
User taps I agree
 → wallets.create(reference GPA-NG-XXXXXX, currency NGN)
 → users.status=active, onboarding_step=done; audit: wallet_created
 → "🎉 You're all set … Balance: ₦0.00"
```
**Note:** onboarding creates the wallet **directly**; it does **not** call
`PartnerAdapter.createVirtualAccount`, so no real NUBAN is provisioned yet. `kyc_id` is stored but
never verified.

### 4.2 Check balance
```
User: "balance"  (or free text like "how much do I have")
 → router: global shortcut OR orchestrator intent 'balance'
 → WalletService.getBalance(wallet.id)  (reads wallets.balance)
 → "💼 Balance: ₦0.00 · Wallet: GPA-NG-XXXXXX"
```

### 4.3 Add demo funds (inbound money → no OTP, by design)
```
User: "fund 5000"
 → orchestrator intent 'fund', amount 5000
 → transactions.create(type=funding, status=completed)
 → WalletService.credit(wallet, 5000)   (atomic: balance + ledger_entry)
 → audit: wallet_funded (demo)
 → "✅ Added ₦5,000 (demo funds). New balance: ₦5,000"
```
This is **simulated** funding for the demo — it does not represent real money landing in a bank
account. (Real inbound funding will come via the Flutterwave `charge.completed` webhook — see §5.)

### 4.4 P2P transfer — the core flow (prepare → confirm → OTP → ledger → receipts)
This is the flagship path and the one that enforces `no-otp-no-money`.

```
User: "send 2000 to 0803xxxxxxx"
 → orchestrator: intent 'p2p_transfer', amount 2000, recipientRef 0803…
 → TransferService.start():
      resolve recipient wallet (by GPA- ref or phone, same currency)
      guard: not self, same currency, ≤ txn_limit, ≤ balance
      transactions.create(status = pending_confirmation)
      send card: "Send ₦2,000 to *Bola A.*?"  [Confirm ✅] [Cancel]

User taps Confirm ✅
 → router sees pending_confirmation + interactiveReplyId 'txn_confirm'
 → TransferService.confirm():
      transactions.setStatus(pending_otp)
      OtpService.issue() → 6-digit code, HASHED into otp_challenges (expiry set)
      "🔐 Your GuildPay code is 123456"    (DEMO: delivered in-channel)

User: "123456"
 → router sees pending_otp + a 4–8 digit reply
 → TransferService.submitOtp():
      OtpService.verify()  ← the ONLY thing that can complete a transaction
      WalletService.transfer(): atomic double-entry —
          conditional debit (locks row + enforces funds) → ledger_entry(debit)
          credit recipient → ledger_entry(credit)   [all in one Postgres txn]
      transactions.setStatus(completed); audit: transfer_completed
      sender:    "✅ Sent ₦2,000 to *Bola A.* New balance: ₦3,000 · Ref: a1b2c3d4"
      recipient: "💰 You received ₦2,000 from *Ada Obi*. New balance: …"
```
Failure branches are handled: wrong/expired code, too many attempts, recipient vanished, insufficient
funds at execution — each sets a terminal status and tells the user no money moved. Typing `CANCEL`
at any pending step aborts cleanly.

### 4.5 Anything else → AI chat fallback
Free text that isn't a recognised intent (`intent = support/unknown`) is answered by
`AiService.chat()` (Groq → Gemini fallback). If the AI is unreachable, a safe canned reply is sent.

---

## 5. The live NGN rail (P0 — shipped)

The Flutterwave NGN rail is wired end-to-end and deployed to production:

- **NUBAN at onboarding** — on NGN consent, `OnboardingService` calls
  `FlutterwavePartnerAdapter.createVirtualAccount` (permanent NUBAN + BVN), stores it on the wallet,
  and shows the funding details. Failure is non-blocking (`virtual_account_failed` audit).
- **Funding → credit** — `charge.completed` → `verifyTransaction` (re-verify at source) → match wallet
  by `tx_ref` (== wallet reference) → `WalletService.credit` → WhatsApp alert. Idempotent on `flw_ref`;
  unmatched deposits are audited (`funding_unmatched`), never blind-credited.
- **Bank transfer (NIP)** — `bank_transfer` intent → resolve bank (`listBanks`) → `nameEnquiry` →
  confirm card with resolved name → OTP → `WalletService.debit` → `bankTransfer` payout. Failed payout
  reverses the debit; `transfer.completed` reconciles (confirm on success, refund on failure).

**Depends on (external):** live webhook configured in the Flutterwave dashboard, BVN + permanent-VA
features enabled, and a funded merchant balance for outbound payouts. See `05 §1.5-live` / `§4`.

---

## 6. Data model (Postgres / Supabase)

Defined in `supabase/migrations/20260709122609_init_core_schema.sql`:

| Table | Role |
|---|---|
| `users` | WhatsApp identity, language, market/currency, `onboarding_step`, `kyc_id`, status |
| `wallets` | One per user/currency: `reference` (GPA-…), `balance` (NUMERIC), `txn_limit`, market |
| `transactions` | Every money action: type, channel, currency, amount, recipient, `status` lifecycle |
| `ledger_entries` | Double-entry rows (debit/credit + `balance_after`) — the audit-grade money trail |
| `otp_challenges` | Hashed OTP codes, expiry, attempt count, `consumed_at` — the completion gate |
| `audit_events` | Every sensitive action (onboarding, wallet, funding, transfer) |

Transaction status lifecycle in use today:
`pending_confirmation → pending_otp → completed` (or `cancelled` / `failed`).

---

## 7. Security invariants currently enforced

- **`no-otp-no-money`** — only `OtpService.verify()` success leads to `WalletService.transfer()`.
  The LLM prepares; it never completes — for both P2P and bank transfer. (38 tests green.)
- **Webhook authenticity** — WhatsApp verifies `X-Hub-Signature-256`; Flutterwave verifies
  `verif-hash` (constant-time compare) before any processing.
- **Atomic ledger** — debit is a single conditional `UPDATE … WHERE balance >= amount` that both locks
  the row and enforces sufficient funds; all-or-nothing inside a Postgres transaction.
- **No secret leakage** — OTP codes stored hashed; the Flutterwave adapter never logs request bodies
  (which carry BVN / account numbers); keys come from env only.
- **Deterministic control flow** — onboarding steps and OTP/confirm handling never depend on the LLM.

---

## 8. What remains for a complete end-to-end MVP

Ordered by what unblocks the most demo value. Mapped to `04_BUILD_PLAN.md` milestones.

### ✅ P0 — the live NGN rail (DONE, in production)
1. ~~Provision a NUBAN at onboarding~~ *(M2b)* — shipped.
2. ~~Credit the ledger from the funding webhook (verified + idempotent)~~ *(M2b)* — shipped.
3. ~~Bank transfer (NIP): name enquiry → OTP → payout → reconcile/refund~~ *(M3b)* — shipped.

### P1 — everyday-money capabilities (deferred by request)
4. **Airtime / data** via `FlutterwaveBillsAdapter.buyAirtime/buyData` + router intents. *(M6a)*
5. **Bill payments** (electricity/cable/betting): `validateCustomer` → pay → token/receipt. *(M6b)*
6. **History / receipts** command + transaction list. *(M8)*

### P2 — differentiators & second market
7. ~~**Voice** (media download → STT → same intent pipeline)~~ *(M4)* — shipped (Groq/Deepgram).
8. **Snap-to-pay** (vision: invoice / bank details / meter / QR → prefilled action). *(M5)*
9. **Savings / target-savings** sub-ledger + **Request money**. *(M9)*
10. **QAR rail** — `MockPartnerAdapter` so Qatar has a first-class demo (onboarding + P2P already work
    ledger-only; this adds a simulated account + funding). *(M2)*
11. **Real KYC/BVN** — replace format-only check with the consent flow OR validate-at-NUBAN-creation
    (see `05 §1.5-live`); cross-check returned phone == WhatsApp number.

### P3 — operator surface & demo hardening
12. **Dashboard** — Overview live feed, Transactions, Risk/OTP console, `/v1/demo/reset`. *(M11)*
13. **Support agent** (FAQ + escalation) *(M10)*, reminder jobs, Pidgin/Arabic language pass.
14. Rehearsals + demo video/screenshot pack. *(Week 4 checkpoint)*

---

## 9. Definition of done (MVP demo, end-to-end)

A single recorded run should show, with a demo reset between takes:

1. New user onboards on WhatsApp (NGN) and receives a **real NUBAN**. ✅ *shipped*
2. A **real bank deposit** into that NUBAN credits the wallet (via webhook). ✅ *shipped*
3. A **P2P transfer** to another GuildPay user, OTP-gated, with receipts. ✅ *shipped*
4. A **bank transfer (NIP)** to an external account: name enquiry → confirm → OTP → payout. ✅ *shipped*
5. **Airtime** purchase and one **bill** payment, each OTP-gated with a receipt. ⬜ *P1*
6. One action driven by **voice** ✅ *shipped* and one by **photo** ⬜ *P2 (snap-to-pay)*.
7. The **dashboard** reflects every action in real time ⬜ *P3*; `no-otp-no-money` suite green ✅.

**Today: items 1–4 and the voice half of 6 are done and live. Remaining for the full demo: airtime/bill
(P1), snap-to-pay photo (P2), and the dashboard (P3).**
