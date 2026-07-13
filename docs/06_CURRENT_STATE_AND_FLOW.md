# GuildPay AI — Current State & End-to-End Flow (as-built)

> **Purpose:** a truthful snapshot of how the system works **right now**, derived from the code in
> `apps/api` — not the aspirational spec. It shows exactly what happens when a customer messages,
> which paths are live, which are built-but-unwired, and what remains for a complete end-to-end MVP.
>
> Last verified against `main` @ commit `29518b6` (Flutterwave NGN adapter + webhook routing).
> Companion to `04_BUILD_PLAN.md` (the checklist) and `05_SETUP_AND_DEPLOY.md` (ops/keys).

---

## 1. What runs today, in one paragraph

A customer messages the GuildPay WhatsApp number. Meta delivers the message to
`POST /webhooks/whatsapp`, which verifies the signature, acknowledges Meta instantly, and processes
in the background. A **deterministic onboarding state machine** walks a first-time user through
language → name → market/currency → KYC id → consent, then creates a wallet row. Once onboarded, a
**message router** handles the user: a pending OTP or Confirm/Cancel is resolved **without the LLM**;
otherwise free text goes to an **LLM intent parser** that returns validated JSON. Today the router can
**check balance**, **add demo funds**, and run a **full P2P transfer** (confirmation card → OTP →
double-entry ledger move → receipts to both parties). Everything else free-text falls back to an AI
chat reply. **All money today moves on the internal Postgres ledger** — the newly-built Flutterwave
(NGN) adapter is not yet called by any live path.

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

Supporting boundaries that exist but are **not yet on the live path**:
`PartnerService → FlutterwavePartnerAdapter (NGN)` / `MockPartnerAdapter (QAR)` and
`BillsService → FlutterwaveBillsAdapter`, plus `POST /webhooks/flutterwave`.

---

## 3. Component status map

| Layer | Component | File | Status |
|---|---|---|---|
| Ingress | WhatsApp webhook (verify + sig + async) | `webhooks/whatsapp.controller.ts` | ✅ Live |
| Channel | Meta Cloud adapter (send, typing, parse) | `channel/meta-cloud.adapter.ts` | ✅ Live |
| Channel | Twilio sandbox adapter (fallback) | `channel/twilio-sandbox.adapter.ts` | ✅ Present |
| Onboarding | State machine → wallet creation | `onboarding/onboarding.service.ts` | ✅ Live (KYC = format-only) |
| Routing | Onboarded-user router | `banking/message-router.service.ts` | ✅ Live |
| AI | Intent parser (zod-validated) | `banking/orchestrator.service.ts` | ✅ Live (balance/fund/p2p/support) |
| AI | Multi-provider fallback (Groq→Gemini) | `ai/ai.service.ts` | ✅ Live |
| Money | Double-entry ledger | `banking/wallet.service.ts` | ✅ Live |
| Money | OTP gate (hashed, Postgres) | `banking/otp.service.ts` | ✅ Live |
| Money | P2P transfer flow | `banking/transfer.service.ts` | ✅ Live |
| Data | Postgres repos (users/wallets/txns/audit) | `database/*.repository.ts` | ✅ Live |
| Data | Schema migrations | `supabase/migrations/*.sql` | ✅ Applied |
| NGN rail | Flutterwave partner adapter | `partner/flutterwave-partner.adapter.ts` | 🟡 Built, **not wired** |
| NGN rail | Flutterwave webhook routing | `webhooks/flutterwave.controller.ts` | 🟡 Verifies + routes + logs; **no ledger credit** |
| QAR rail | Mock partner adapter | `partner/mock-partner.adapter.ts` | ⛔ Stub |
| Bills | Flutterwave bills adapter | `bills/flutterwave-bills.adapter.ts` | ⛔ Stub |
| Dashboard | Next.js admin | `apps/dashboard/app/*` | ⛔ Skeleton only |
| Multimodal | Voice (Whisper), Vision (snap-to-pay) | — | ⛔ Not started |

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

## 5. Built but NOT yet on the live path (the wiring gap)

The Flutterwave NGN rail now **exists in code** but nothing in the runtime calls it:

- `FlutterwavePartnerAdapter` implements `createVirtualAccount` (permanent NUBAN + BVN),
  `nameEnquiry`, `bankTransfer` (NIP), and `verifyTransaction` against Flutterwave v3.
  → **Not invoked** by onboarding, the router, or any capability yet.
- `POST /webhooks/flutterwave` verifies `verif-hash` and routes `charge.completed` /
  `transfer.completed` / `bvn.verification.completed`, but the handlers **only log** —
  crediting/debiting the ledger is marked `TODO(M2)`.

**Consequence:** a user cannot yet (a) receive a real NUBAN at onboarding, (b) be funded by a real
bank deposit, or (c) send to an external bank. Those need the wiring in §6.

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
  The LLM prepares; it never completes. (Covered by the test suite; 23 tests green.)
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

### P0 — make the NGN rail real (wire what's already built)
1. **Provision a NUBAN at onboarding** — call `PartnerService.forCurrency('NGN').createVirtualAccount`
   after consent (pass email + BVN + name), store `account_number`/`bank_name`, show it to the user so
   they have somewhere to pay into. *(M2b)*
2. **Credit the ledger from the funding webhook** — in `flutterwave.controller.ts` `charge.completed`:
   `verifyTransaction(id)` → match amount/currency → `WalletService.credit` + `audit`. Add idempotency
   on `flw_ref`. *(M2b)*
3. **Bank transfer (NIP) capability** — add a `bank_transfer` intent + flow: `nameEnquiry` → show
   resolved name in the confirm card → OTP → `bankTransfer` → reconcile on `transfer.completed`. *(M3b)*

### P1 — the everyday-money capabilities the pitch promises
4. **Airtime / data** via `FlutterwaveBillsAdapter.buyAirtime/buyData` + router intents. *(M6a)*
5. **Bill payments** (electricity/cable/betting): `validateCustomer` → pay → token/receipt. *(M6b)*
6. **History / receipts** command + transaction list. *(M8)*
7. Extend `no-otp-no-money` + `audit_events` coverage to every new money action.

### P2 — differentiators & second market
8. **Voice** (media download → Whisper → same intent pipeline). *(M4)*
9. **Snap-to-pay** (vision: invoice / bank details / meter / QR → prefilled action). *(M5)*
10. **Savings / target-savings** sub-ledger + **Request money**. *(M9)*
11. **QAR rail** — implement `MockPartnerAdapter` so Qatar onboarding + P2P is a first-class demo. *(M2)*
12. **Real KYC/BVN** — replace format-only check with the consent flow OR validate-at-NUBAN-creation
    (see `05 §1.5-live`); cross-check returned phone == WhatsApp number.

### P3 — operator surface & demo hardening
13. **Dashboard** — Overview live feed, Transactions, Risk/OTP console, `/v1/demo/reset`. *(M11)*
14. **Support agent** (FAQ + escalation) *(M10)*, reminder jobs, Pidgin/Arabic language pass.
15. Rehearsals + demo video/screenshot pack. *(Week 4 checkpoint)*

---

## 9. Definition of done (MVP demo, end-to-end)

A single recorded run should show, with a demo reset between takes:

1. New user onboards on WhatsApp (NGN) and receives a **real sandbox NUBAN**.
2. A **real sandbox bank deposit** into that NUBAN credits the wallet (via webhook).
3. A **P2P transfer** to another GuildPay user, OTP-gated, with receipts. ✅ *works today*
4. A **bank transfer (NIP)** to an external account: name enquiry → confirm → OTP → payout → receipt.
5. **Airtime** purchase and one **bill** payment, each OTP-gated with a receipt.
6. At least one action driven by **voice** and one by **photo**.
7. The **dashboard** reflects every action in real time; `no-otp-no-money` suite is green.

**Today: item 3 is fully done; items 1–2 and 4–5 are one wiring layer away (code exists for the NGN
rail); items 6–7 are net-new.**
