# GuildPay AI — Vision & Architecture (north star)

> Read this first. It defines **what GuildPay AI is**, the **conversational-neobank flow**, and the
> **architecture** every other doc and every line of code must serve. If a later doc contradicts this
> file, this file wins.

---

## 1. What we're building

GuildPay AI is a **WhatsApp-native, AI-powered financial assistant** — a full wallet / neobank that
lives entirely inside WhatsApp. A user creates a virtual account, funds it, and performs **every
everyday money action** — send to another user, transfer to any bank, buy airtime/data, pay bills,
save — **by simply talking to the AI** in natural language, voice notes, or photos. No app, no forms.

**The product is the conversation.** The user says *"send 5k to my brother"* or sends a voice note
*"buy 1000 airtime for 0803…"* or snaps a photo of an invoice, and GuildPay understands, confirms,
takes the PIN/OTP, moves the money, and returns a receipt.

### Reference point: Xara (usexara.ai)
GuildPay is the same category as **Xara**, a WhatsApp AI financial assistant in Nigeria: transfers to
50+ banks, spending insights, multimodal (text/voice/image), PIN-protected payments, English/Pidgin,
NDPC-certified. GuildPay targets the **same conversational-banking experience**, across **two markets**.

---

## 2. Markets (co-equal)

| Market | Currency | Settlement | Notes |
|---|---|---|---|
| **Nigeria** | **NGN** | **Flutterwave sandbox** (real-ready) | Virtual NUBAN accounts, bank payout (NIP), airtime/data/bills via Flutterwave Bills. The flagship, feature-complete rail. |
| **Qatar** | **QAR** | **Simulated double-entry ledger** | Wallet + P2P + internal transfer only (airtime/bills/NIP are Nigeria-specific). Demonstrates multi-market design. |

The **currency chosen at onboarding selects the rail**. All flows are currency-agnostic and resolve
their provider at runtime — adding a market or swapping a licensed partner is a registration change,
not a rewrite.

---

## 3. Money model: sandbox now, real-ready

The MVP moves **test money only** — Flutterwave **sandbox** for NGN, a **simulated ledger** for QAR.
No customer funds, no license required to demo. But the architecture is built so that going live is a
**config + adapter swap**, not a redesign:

- All external money movement is behind a **`PartnerAdapter`** (per rail) and **`BillsAdapter`** (VTU).
- Going live = point the same adapters at live keys + a licensed partner (PSSP/MFB/PSB in Nigeria),
  add KYC/BVN verification, and flip `MONEY_MODE=live`.
- The internal **`WalletService`** (double-entry ledger) is always the source of truth for balances,
  regardless of rail — so receipts, limits, and history stay consistent sandbox or live.

> **Compliance reality (must stay visible):** real NGN payouts to banks require a licensed partner +
> BVN/KYC + NDPC data-protection posture. That is a licensing track, tracked separately. The MVP
> proves the full UX on sandbox rails.

---

## 4. Architecture

```
WhatsApp (text · voice · image · buttons)
        │  Meta Cloud API (Twilio Sandbox fallback)  — behind ChannelAdapter
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       GuildPay AI Backend (NestJS)                     │
│                                                                        │
│  ChannelAdapter → Conversation State Machine (Redis) → AI Orchestrator │
│                          │                                  │(Claude)  │
│                          ▼                                  ▼          │
│                     Intent Router ───────────────► Capability Modules  │
│                                                    (one per action)    │
│   transfer · bank-transfer · airtime · data · bills · savings ·        │
│   request-money · fund · balance · history · spending-insights ·       │
│   onboarding · support                                                 │
│                          │                                             │
│                          ▼                                             │
│   ┌────────────────┐   ┌──────────────────────┐   ┌────────────────┐   │
│   │  WalletService │   │  PartnerAdapter       │   │  BillsAdapter  │   │
│   │  (ledger =     │   │  (per currency)       │   │  (VTU)         │   │
│   │   source of    │   │  NGN → Flutterwave    │   │  NGN →         │   │
│   │   truth)       │   │  QAR → Mock(sim)      │   │  Flutterwave   │   │
│   └────────────────┘   │  · virtual account   │   │  Bills         │   │
│                        │  · name enquiry      │   └────────────────┘   │
│   OTP/PIN Service ─────│  · bank payout (NIP) │                        │
│   (the ONLY thing that │  · fund detection    │   Receipt Engine       │
│    completes a txn)    └──────────────────────┘   Audit / Reminders    │
└──────────────────────────────────────────────────────────────────────┘
        │
        ▼  Supabase (Postgres system of record + ledger, Storage for media, Auth)  ·  Dashboard (Next.js)
```

### 4.1 Core principles (non-negotiable)
1. **State-machine first, LLM second.** Deterministic steps (onboarding, OTP entry, button taps) never
   depend on the LLM. The LLM only *interprets* free-form content into a validated intent.
2. **The AI PREPARES, it never COMPLETES.** Only the OTP/PIN verifier moves a transaction
   `pending_otp → completed`. Test `no-otp-no-money` enforces this for **every** capability and rail.
3. **All money movement goes through an adapter.** Capability modules call `WalletService` +
   `PartnerAdapter`/`BillsAdapter` — never a provider SDK or the ledger directly.
4. **Every extraction is validated JSON (zod).** On failure: one retry, then ask — never guess an
   amount, recipient, or biller.
5. **Every sensitive action writes an `audit_events` row.** Never log PINs, OTPs, BVN, or full QID/NUBAN.

### 4.2 The three money abstractions
- **`WalletService`** — internal multi-currency double-entry ledger. Holds/debits/credits wallet
  balances. Source of truth for balance, limits, statements. Rail-independent.
- **`PartnerAdapter`** (one per currency) — external settlement + account services:
  `createVirtualAccount`, `nameEnquiry`, `bankTransfer` (NIP payout), `fund` (detect inbound), `getBalance`.
  NGN → `FlutterwavePartnerAdapter`; QAR → `MockPartnerAdapter`.
- **`BillsAdapter`** (VTU) — `buyAirtime`, `buyData`, `payBill` (electricity/cable/betting),
  `listBillers`, `validateCustomer`. NGN → `FlutterwaveBillsAdapter`.

Resolution: `PartnerService.forCurrency(currency)` and `BillsService.forCountry(country)`.

---

## 5. Conversational flow (canonical)

1. Inbound WhatsApp message → `ChannelAdapter` normalizes to `InboundMessage`.
2. Voice → Whisper transcript; image → Claude vision extraction.
3. State machine loads session (Redis). If mid-flow (e.g. awaiting OTP), handle deterministically.
4. Otherwise AI Orchestrator classifies **intent** (`transfer`, `airtime`, `bill`, `balance`, …) and
   extracts a **validated payload** (recipient, amount, biller, currency…).
5. Intent Router dispatches to the capability module. Module builds a **draft transaction**, replies
   with a **confirmation card** (name-enquiry result, amount, fee) → `pending_confirmation`.
6. User confirms → **OTP/PIN challenge** → verify → `WalletService` debits + `PartnerAdapter`/
   `BillsAdapter` executes → `completed` → **receipt** + `audit_events`.
7. Anything ambiguous → clarifying question. Global keywords `CANCEL / BALANCE / HELP` always work.

---

## 6. Capability catalogue (MVP)

| Capability | NGN | QAR | Provider |
|---|---|---|---|
| Onboarding + create virtual account | ✔ | ✔ | Flutterwave virtual account / simulated ref |
| Fund wallet (detect inbound) | ✔ | ✔ (simulated) | Flutterwave webhook / admin credit |
| Balance & transaction history | ✔ | ✔ | WalletService |
| Send to GuildPay user (P2P) | ✔ | ✔ | WalletService |
| Transfer to any bank (NIP) | ✔ | ✖ | Flutterwave (name enquiry + payout) |
| Buy airtime / data | ✔ | ✖ | Flutterwave Bills |
| Pay bills (electricity, cable, betting) | ✔ | ✖ | Flutterwave Bills |
| Savings / target-savings | ✔ | ✖ | WalletService (sub-ledger) |
| Request money | ✔ | ✔ | WalletService |
| Spending insights | ✔ | ✔ | WalletService analytics |
| AI support | ✔ | ✔ | Claude + FAQ corpus |
| Admin dashboard | ✔ | ✔ | Next.js |

**Explicitly out of MVP:** virtual cards, crypto, lending/credit, international transfers, live money.

---

## 7. Security & compliance posture
- OTP/PIN on every money action, PIN change, and account freeze; session timeout; per-txn & daily limits.
- KYC: **BVN/phone** (NGN), **QID** (QAR) — captured at onboarding, verification stubbed in sandbox.
- Data protection: NDPC-aligned (Nigeria); PII minimization; audit trail on every sensitive action.
- Fraud basics: velocity limits, new-beneficiary cool-off, freeze-on-report.
