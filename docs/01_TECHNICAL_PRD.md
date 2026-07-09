# GuildPay AI — Technical PRD & Implementation Plan

**Version:** 2.0 · July 2026
**Owner:** David Uzochukwu, Guild Technologies LLC (QFC #04407)
**Status:** Build-ready specification for the incubation-demo MVP
**Companion documents:** `docs/00_VISION_AND_ARCHITECTURE.md` (north star), GuildPay AI Business Plan

> **⚠️ Reframe (v2):** GuildPay AI is a **WhatsApp-native conversational neobank** — a full wallet where
> users create a virtual account and do **every everyday money action** (send to a user, transfer to any
> bank, buy airtime/data, pay bills, save) by natural language, voice, or photo. Same category as
> **Xara** (usexara.ai). Two co-equal markets: **NGN (Nigeria, flagship, Flutterwave sandbox)** and
> **QAR (Qatar, simulated ledger, wallet+transfer subset)**. Money is **sandbox/simulated, real-ready**.
> `docs/00_VISION_AND_ARCHITECTURE.md` and `docs/03_MVP_SCOPE.md` are authoritative for scope; where the
> module-by-module sections below still read as "Qatar QAR payments only," treat them as being aligned
> to that vision (capability modules + `WalletService` / `PartnerAdapter` / `BillsAdapter`).

---

## 1. Purpose & Scope of This Document

This document translates the Functional MVP Scope into an engineering-executable specification. It defines the system architecture, technology stack, data model, API contracts, module-by-module requirements, AI orchestration design, security controls, environment setup, testing plan, demo runbook, and a week-by-week implementation plan with acceptance criteria.

**In scope:** Everything needed to build the 4-week, incubation-ready WhatsApp conversational-banking demo across NGN + QAR on sandbox/simulated rails.
**Out of scope:** Live money movement, licensed bank/PSSP integration, virtual/physical cards, international transfers, crypto, lending, mobile apps.

**Definition of done:** A reviewer onboards in WhatsApp, receives a virtual account, and by text / voice / photo completes a P2P transfer, a **bank transfer (with name enquiry)**, an **airtime/data purchase**, and a **bill payment** — each with OTP/PIN and a receipt — plus creates a savings goal and asks the AI support questions, with the presenter showing all of it live in an admin dashboard, reliably, in a 7–10 minute demo.

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
                        ┌──────────────────────────────────────────────┐
                        │                 WhatsApp User                │
                        │   text · voice note · image · xlsx · buttons│
                        └──────────────┬───────────────────────────────┘
                                       │  Meta WhatsApp Cloud API (webhooks)
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        GuildPay AI Backend (Node/TS)                     │
│                                                                          │
│  ┌────────────┐   ┌──────────────┐   ┌──────────────┐   ┌────────────┐  │
│  │ WhatsApp   │──▶│ Conversation │──▶│ AI           │──▶│ Action     │  │
│  │ Gateway    │   │ State Machine│   │ Orchestrator │   │ Router     │  │
│  │ (webhook + │   │ (Redis)      │   │ (Claude API) │   │            │  │
│  │  sender)   │   └──────────────┘   └──────────────┘   └─────┬──────┘  │
│  └────────────┘                                               │         │
│        ▲                                                      ▼         │
│        │        ┌───────────┐  ┌───────────┐  ┌───────────────────────┐ │
│        │        │ STT       │  │ OCR/Vision│  │ Excel Parser &        │ │
│        │        │ Service   │  │ Extraction│  │ Batch Validator       │ │
│        │        └───────────┘  └───────────┘  └───────────────────────┘ │
│        │                                                                │
│  ┌─────┴──────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Receipt    │◀─│ Demo Ledger  │◀─│ OTP/PIN      │  │ Notification/ │  │
│  │ Engine     │  │ Service      │  │ Service      │  │ Reminder Jobs │  │
│  └────────────┘  └──────┬───────┘  └──────────────┘  └───────────────┘  │
│                         │                                               │
└─────────────────────────┼───────────────────────────────────────────────┘
                          ▼
              ┌──────────────────────┐        ┌──────────────────────┐
              │ PostgreSQL (system   │        │ Admin Dashboard      │
              │ of record) + object  │◀──────▶│ (Next.js, read/write │
              │ storage for media    │        │ over internal API)   │
              └──────────────────────┘        └──────────────────────┘
```

### 2.2 Architectural Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| AD-1 | WhatsApp channel | **Meta WhatsApp Cloud API** (direct), Twilio Sandbox as fallback | Free-tier friendly, no BSP margin, supports interactive buttons/lists, media download APIs. Twilio sandbox available same-day if Meta business verification is slow. |
| AD-2 | Backend runtime | **Node.js 20 + TypeScript, NestJS** (or Fastify if you prefer lean) | Matches David's existing stack familiarity; strong typing for financial data; NestJS modules map 1:1 to the 10 MVP modules. |
| AD-3 | Database | **PostgreSQL 16 (Supabase)** | Row-level audit history, JSONB for AI extraction payloads, Supabase gives instant auth + storage + dashboard-friendly API. |
| AD-4 | Session/state | **Redis** (Upstash or Supabase-adjacent) | Conversation state machine, OTP TTLs, session timeouts, rate limits. |
| AD-5 | AI engine | **Claude API (claude-sonnet-4-6)** for intent extraction, support, and vision OCR | One vendor covers NLU + support + image extraction; tool-use for structured JSON output; strong Arabic/English handling. |
| AD-6 | Speech-to-text | **OpenAI Whisper API** (or Google STT v2) | Best Arabic + accented-English performance for Qatar's user mix; WhatsApp voice notes are OGG/Opus — Whisper accepts directly. |
| AD-7 | OCR strategy | **Claude vision as primary extractor**, Google Vision OCR as optional pre-pass for dense bills | Claude vision reads bills/QRs/screenshots and returns structured JSON in one call; avoids a separate OCR + parsing pipeline for MVP. |
| AD-8 | Excel parsing | **SheetJS (xlsx)** server-side | Battle-tested, streams rows, no Office dependency. |
| AD-9 | Dashboard | **Next.js 14 + Supabase client + shadcn/ui** | Fast to build, real-time subscriptions for live-demo "wow" (transactions appear on screen as the reviewer sends them). |
| AD-10 | Hosting | **Single VPS (Hetzner/Contabo) with Docker Compose**, or Railway for zero-ops | MVP needs one always-on box for webhooks; can later migrate onto Guild Server infrastructure as a dogfooding story. |
| AD-11 | Ledger | **Double-entry demo ledger in Postgres** | Even simulated, double-entry gives clean receipts, balance integrity, and a credible partner conversation. Mock partner API wraps it. |
| AD-12 | Mock partner layer | All ledger calls go through a `PartnerAdapter` interface | Swapping in a licensed partner later means implementing one interface, not rewriting flows. |

### 2.3 Message Lifecycle (canonical request path)

1. Meta delivers webhook → `POST /webhooks/whatsapp` (verify `X-Hub-Signature-256`).
2. Gateway normalizes to internal `InboundMessage` (type: text | audio | image | document | interactive).
3. Media types trigger a download from the Meta media endpoint → object storage → pre-processor (STT / vision / xlsx parser).
4. Conversation State Machine loads session from Redis (`session:{waPhone}`), determines current flow step.
5. AI Orchestrator called only when interpretation is needed (free-text intent, extraction, support Q&A). Deterministic steps (OTP entry, button confirmations) bypass the LLM.
6. Action Router executes: ledger ops, OTP issuance, receipt generation, support answer.
7. Outbound messages sent via Cloud API (template / interactive / text / document), all logged to `messages` table.
8. Every state transition writes an `audit_events` row.

**Latency budgets:** text intent ≤ 3s, voice note ≤ 8s, image extraction ≤ 10s, Excel validation ≤ 15s for 200 rows. Send a typing indicator / "Processing…" interim message when a step exceeds 2s.

---

## 3. Technology Stack (Bill of Materials)

| Layer | Technology | Purpose | Est. monthly cost (MVP) |
|---|---|---|---|
| Messaging | Meta WhatsApp Cloud API | Inbound/outbound WhatsApp | Free tier (1,000 conversations/mo) |
| Backend | Node 20 / TypeScript / NestJS | Core services | — |
| AI | Anthropic Claude API (Sonnet) | Intent, support, vision extraction | ~$30–80 demo-stage usage |
| STT | Whisper API | Voice note transcription | ~$5–15 |
| DB | Supabase (Postgres + Storage + Auth) | System of record, media, dashboard auth | Free → $25 Pro |
| Cache | Upstash Redis | Sessions, OTP, rate limits | Free tier |
| Dashboard | Next.js 14 + shadcn/ui + Recharts | Admin/partner demo UI | — |
| Hosting | Railway or Hetzner CX32 + Docker | Backend + dashboard | $10–25 |
| PDF receipts | pdf-lib or Playwright print | Branded PDF receipts (optional; text receipts first) | — |
| Observability | Pino logs + Sentry free tier | Debugging during demo prep | Free |
| Tunneling (dev) | ngrok / Cloudflare Tunnel | Local webhook testing | Free |

**Total MVP infrastructure burn: ≈ $70–150/month.**

### 3.1 Accounts & Prerequisites Checklist (do these on Day 1 — longest lead times)

- [ ] Meta Business Manager account verified for **Guild Technologies LLC** (business verification can take 1–5 days — start immediately).
- [ ] WhatsApp Business Platform app created; test number issued; display name "GuildPay AI" submitted for review.
- [ ] Fallback: Twilio account + WhatsApp Sandbox activated (instant) in case Meta verification stalls past Week 1.
- [ ] Anthropic API key (org account), OpenAI API key (Whisper).
- [ ] Supabase project (region: closest to Qatar — currently AWS `me-central-1` unavailable on Supabase; use `eu-central-1`/Frankfurt, ~90ms to Doha).
- [ ] Upstash Redis database.
- [ ] Domain + subdomain (`api.guildpay.ai` or similar) with TLS for the webhook endpoint.
- [ ] Railway project or Hetzner VPS with Docker.
- [ ] Sentry project, GitHub repo (monorepo: `apps/api`, `apps/dashboard`, `packages/shared`).

---

## 4. Data Model

### 4.1 Entity-Relationship Overview

```
users ─1:1─ accounts ─1:N─ ledger_entries
  │                │
  │                └─1:N─ transactions ─1:N─ receipts
  │                              │
  │                              └─0:1─ batch_items ─N:1─ batches
  ├─1:N─ messages
  ├─1:N─ support_tickets
  ├─1:N─ otp_challenges
  └─1:N─ audit_events        reminders (QID expiry, low balance)
```

### 4.2 Table Definitions (PostgreSQL)

```sql
-- USERS: onboarded WhatsApp identities
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_phone        TEXT UNIQUE NOT NULL,          -- E.164, e.g. +974XXXXXXXX
  full_name       TEXT,
  language        TEXT NOT NULL DEFAULT 'en',    -- 'en' | 'ar' (extensible: 'hi','ur','tl')
  qid_number      TEXT,                          -- store masked in UI: 2XXXXXXX123
  qid_expiry      DATE,
  consent_at      TIMESTAMPTZ,
  pin_hash        TEXT,                          -- argon2id
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|active|frozen|closed
  onboarding_step TEXT NOT NULL DEFAULT 'start',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ACCOUNTS: demo QAR wallet reference
CREATE TABLE accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  reference   TEXT UNIQUE NOT NULL,              -- e.g. GPA-2026-000123
  currency    TEXT NOT NULL DEFAULT 'QAR',
  balance     NUMERIC(14,2) NOT NULL DEFAULT 0,  -- denormalized; ledger is source of truth
  status      TEXT NOT NULL DEFAULT 'active',    -- active|frozen
  daily_limit NUMERIC(14,2) NOT NULL DEFAULT 5000,
  txn_limit   NUMERIC(14,2) NOT NULL DEFAULT 2000,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- LEDGER: double-entry, append-only
CREATE TABLE ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL,
  account_id     UUID NOT NULL REFERENCES accounts(id),
  direction      TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_after  NUMERIC(14,2) NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- TRANSACTIONS: one row per user-visible payment/funding action
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  type            TEXT NOT NULL,     -- p2p|bill|merchant|funding|batch_item|refund
  channel         TEXT NOT NULL,     -- text|voice|image|excel|admin|system
  status          TEXT NOT NULL DEFAULT 'draft',
                  -- draft → pending_confirmation → pending_otp → completed | failed | cancelled | expired
  amount          NUMERIC(14,2) NOT NULL,
  fee             NUMERIC(14,2) NOT NULL DEFAULT 0,
  recipient_name  TEXT,
  recipient_ref   TEXT,
  purpose         TEXT,
  ai_extraction   JSONB,             -- raw structured output from the AI orchestrator
  source_media_id UUID,              -- link to stored voice/image/xlsx
  batch_id        UUID,
  confirmed_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- BATCHES: Excel bulk uploads
CREATE TABLE batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id),
  file_media_id UUID NOT NULL,
  row_count     INT NOT NULL,
  valid_rows    INT NOT NULL,
  error_rows    INT NOT NULL,
  total_amount  NUMERIC(14,2) NOT NULL,
  total_fees    NUMERIC(14,2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'validating',
                -- validating → pending_approval → pending_otp → processing → completed|partially_completed|failed|cancelled
  validation_report JSONB,           -- row-level flags: missing, duplicate, invalid, high_risk
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- OTP CHALLENGES
CREATE TABLE otp_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  purpose      TEXT NOT NULL,        -- payment|batch|pin_change|freeze|unfreeze
  subject_id   UUID,                 -- transaction_id or batch_id
  code_hash    TEXT NOT NULL,        -- hashed 6-digit code
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  expires_at   TIMESTAMPTZ NOT NULL, -- now() + 5 minutes
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- RECEIPTS
CREATE TABLE receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  batch_id       UUID REFERENCES batches(id),
  receipt_number TEXT UNIQUE NOT NULL,  -- RCP-2026-000001
  payload        JSONB NOT NULL,        -- everything printed on the receipt
  pdf_media_id   UUID,                  -- optional branded PDF
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- MESSAGES: full WhatsApp conversation log
CREATE TABLE messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  direction   TEXT NOT NULL,           -- inbound|outbound
  wa_message_id TEXT,
  type        TEXT NOT NULL,           -- text|audio|image|document|interactive|template
  body        TEXT,
  media_id    UUID,
  meta        JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- MEDIA: voice notes, images, xlsx files, receipt PDFs
CREATE TABLE media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,
  kind        TEXT NOT NULL,           -- voice|image|xlsx|receipt_pdf
  storage_path TEXT NOT NULL,          -- Supabase storage key
  mime_type   TEXT,
  transcript  TEXT,                    -- STT output for voice
  extraction  JSONB,                   -- vision/xlsx structured output
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- SUPPORT
CREATE TABLE support_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  question    TEXT NOT NULL,
  ai_response TEXT,
  category    TEXT,                    -- account|funding|payment|receipt|qid|security|bulk|other
  status      TEXT NOT NULL DEFAULT 'resolved', -- resolved|escalated
  escalation_reason TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- REMINDERS (QID expiry, low balance)
CREATE TABLE reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,           -- qid_expiry|low_balance|payment_followup
  due_at      TIMESTAMPTZ NOT NULL,
  sent_at     TIMESTAMPTZ,
  payload     JSONB
);

-- AUDIT: append-only trail of everything sensitive
CREATE TABLE audit_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID,
  actor       TEXT NOT NULL,           -- user|ai|admin|system
  event       TEXT NOT NULL,           -- e.g. txn.created, otp.verified, account.frozen
  subject_id  UUID,
  detail      JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

**Ledger invariants (enforce in service layer + nightly check job):**
1. Every completed transaction produces balanced debit/credit entries (user account ↔ internal settlement account).
2. `accounts.balance` must equal the last `balance_after` for that account; a `reconcile()` job asserts this and flags drift to the dashboard Risk panel.
3. Ledger rows are never updated or deleted — corrections are reversal entries.

---

## 5. Conversation State Machine

The bot is **state-machine-first, LLM-second**. Deterministic flows (onboarding steps, OTP entry, confirmations) never rely on the LLM for control flow — the LLM only interprets free-form content. This is what makes the demo reliable.

### 5.1 Session Object (Redis, TTL 30 min sliding)

```json
{
  "userId": "uuid",
  "flow": "idle | onboarding | payment | batch | support | security",
  "step": "awaiting_otp",
  "context": {
    "draftTransactionId": "uuid",
    "retries": 0,
    "language": "en"
  },
  "lastActivityAt": "2026-07-05T10:00:00Z"
}
```

- **Sensitive-flow timeout:** if `flow` ∈ {payment, batch, security} and inactivity > 5 min → cancel draft, notify user, log `session.expired`.
- **Interrupt handling:** if a user mid-payment types a support question, the orchestrator classifies it; support answers are given inline and the payment flow resumes ("Your pending payment to Ahmed for QAR 200 is still awaiting your PIN — reply with your PIN or CANCEL").
- **Global keywords (work in any state):** `CANCEL`, `BALANCE`, `HELP`, `HISTORY`, `FREEZE`, `MENU`, plus Arabic equivalents.

### 5.2 Top-Level Router Logic

```
inbound message
 ├─ user not found → onboarding flow
 ├─ user.status = frozen → only support/security flows allowed
 ├─ session.step = awaiting_otp/awaiting_pin → deterministic verifier (no LLM)
 ├─ interactive button reply → mapped action (no LLM)
 ├─ media (audio/image/document) → pre-processor → AI extraction → flow entry
 └─ free text → AI intent classifier → flow entry
```

### 5.3 Intent Taxonomy (AI classifier output)

| Intent | Example | Routed flow |
|---|---|---|
| `payment.p2p` | "Send 200 to Ahmed for lunch" | Payment |
| `payment.bill` | "Pay my Kahramaa bill" | Payment (bill subtype) |
| `payment.merchant` | "Pay this shop QAR 75" | Payment |
| `account.balance` | "What's my balance" | Instant answer |
| `account.history` | "Show my last 5 transactions" | Instant answer |
| `account.fund` | "How do I add money" | Funding instructions |
| `receipt.fetch` | "Resend my last receipt" | Receipt engine |
| `security.freeze` | "Freeze my account" | Security flow (OTP) |
| `security.pin_reset` | "I forgot my PIN" | Security flow (OTP) |
| `support.general` | "Why did my payment fail" | AI support |
| `qid.update` | "Update my QID expiry" | Profile flow |
| `smalltalk/other` | "Hi" / unclear | Menu + suggestions |

---

## 6. AI Orchestration Design

### 6.1 Principles

1. **Structured output always.** Every LLM call that feeds a flow must return validated JSON (use tool-use / JSON mode + Zod schema validation server-side). If validation fails → one retry with error feedback → then graceful fallback ("I couldn't fully read that — can you confirm the amount?").
2. **The AI never moves money.** It produces a *draft transaction*; only the deterministic OTP/PIN verifier can transition `pending_otp → completed`. (MVP Scope §8 Security Rule.)
3. **Confidence gating.** Extraction fields carry confidence; any field < 0.8 becomes a clarifying question instead of a prefilled value.
4. **Language mirroring.** Respond in the user's registered language; auto-detect switches mid-conversation.

### 6.2 Core Prompt Contracts

**(a) Intent + entity extraction (text & voice transcript):**

```
System: You are the payment intent parser for GuildPay AI, a Qatar QAR
demo wallet. Extract structured intent from the user message. Currency
is always QAR unless another is explicitly stated (then flag as
unsupported). Return ONLY JSON matching the schema.

Schema:
{
  "intent": "<taxonomy value>",
  "amount": number | null,
  "recipient_name": string | null,
  "recipient_ref": string | null,
  "purpose": string | null,
  "confidence": { "amount": 0-1, "recipient": 0-1 },
  "clarification_needed": string[]   // fields to ask about
}
```

**(b) Snap-to-pay vision extraction (image input):**

```
System: Extract payment details from this image (bill, invoice, account
details, QR screenshot, or payment screenshot). Return ONLY JSON:
{
  "document_type": "bill|invoice|account_details|qr|screenshot|unknown",
  "recipient_name": ..., "recipient_ref": ..., "amount": ...,
  "due_date": ..., "invoice_number": ..., "confidence": {...},
  "warnings": []   // e.g. "amount partially obscured"
}
Never guess digits you cannot read; use null and add a warning.
```

**(c) AI support agent (RAG-lite):**

- System prompt embeds: GuildPay FAQ corpus (~30 curated Q&As covering funding, failed payments, receipts, QID, limits, security, bulk uploads), the user's status snapshot (balance, last 3 transactions, QID expiry, account status), and escalation rules.
- Tools available to the support agent: `get_transaction(id|last)`, `get_receipt(id|last)`, `get_balance()`, `list_transactions(n)`, `initiate_freeze()`, `initiate_pin_reset()`, `escalate(reason)`.
- Escalation policy: escalate only for (i) suspected fraud/dispute, (ii) data the tools can't retrieve, (iii) user explicitly requests a human. Everything else must be resolved in-chat.

### 6.3 Voice Pipeline

1. Webhook delivers audio message ID → download OGG/Opus from Meta media API.
2. Store to Supabase Storage → send to Whisper (`language` hint from user profile, fall back to auto).
3. Transcript → same intent extraction as text, with `channel = voice`.
4. Reply pattern: *"I heard: 'Send 150 riyal to Fatima for groceries.' Here's the summary…"* — always show the transcript so the user can catch mishears (a trust feature worth showing in the demo).

### 6.4 Cost & Latency Guardrails

- Cache the FAQ corpus with prompt caching → support calls drop to ~⅕ input cost.
- Haiku-class model for intent classification, Sonnet for vision + support (configurable per-route).
- Hard cap: 20 LLM calls/user/hour (demo abuse guard).

---

## 7. Module Specifications (maps 1:1 to MVP Scope §4)

For each module: requirements, message design, API surface, and acceptance criteria (AC).

### M1 — WhatsApp Entry & Onboarding

**Flow:** QR/wa.me link → welcome + language picker (interactive buttons EN/عربي) → name → QID number (validated: 11 digits, starts 2/3) → QID expiry (date parse, must be future) → consent (button: "I Agree") → profile created → account issued → funding instructions.

**Design details:**
- Each step re-prompts up to 2× on invalid input, then offers examples.
- QID is echoed back masked (`2•••••••123`) for confirmation.
- Consent message contains a short T&C summary + link; timestamp stored in `users.consent_at`.
- Completion message: account reference, balance QAR 0.00, "Reply FUND to add demo money", quick-action buttons (Fund · Pay · Help).

**API:** internal only — `POST /internal/users`, `POST /internal/accounts`.

**AC:** New number completes onboarding in < 3 minutes; record visible in dashboard Users panel including QID expiry and language; duplicate onboarding attempt returns "You already have an account (GPA-…)".

### M2 — Demo QAR Account / Wallet Ledger

- Account reference format `GPA-YYYY-XXXXXX` (sequential, non-guessable suffix optional).
- Funding: (a) admin credits from dashboard, (b) user types `FUND 500` → simulated instant credit labeled *DEMO FUNDING*, capped at QAR 10,000 balance.
- `BALANCE` returns balance + last transaction + limits.
- All movements via `PartnerAdapter.credit()/debit()` → double-entry ledger.

**AC:** Funding notification arrives in WhatsApp within 3s of admin credit; ledger entries balance; balance in chat always equals dashboard.

### M3 — Text Payment Flow

**Happy path:** free text → extraction → *confirmation card*:

```
📋 Payment Summary
To:       Ahmed Al-Sayed
Ref:      GPA-2026-000456
Amount:   QAR 200.00
Purpose:  Lunch
Fee:      QAR 0.00
Balance after: QAR 1,300.00
[Confirm] [Edit] [Cancel]
```

→ Confirm → OTP sent → user enters OTP → ledger posts → receipt.

**Edge cases:** insufficient balance (offer FUND), amount > txn limit, missing recipient (clarify), recipient not found in demo directory (offer to create demo beneficiary), OTP wrong ×3 (cancel + audit + support hint), OTP expired (offer resend).

**AC:** End-to-end text payment ≤ 60s including OTP; no path exists where a transaction completes without a verified OTP/PIN (verified by integration test).

### M4 — Voice Note Payment Flow

As M3 with STT front-end. Additional ACs: transcript shown to user before summary; unclear audio → specific clarifying question ("I caught the recipient as Fatima but not the amount — how much?"); support questions by voice also work.

### M5 — Snap-to-Pay Flow

Accepts: photo of bill/invoice, account-detail screenshot, QR image, payment screenshot.
- Extracted fields displayed with an explicit **review step** — user can tap Edit to correct any field via short guided prompts.
- Warnings surfaced ("The amount was partially unclear — please confirm QAR 350").
- QR images: decode with `jsQR`/`zxing` first (deterministic); fall back to vision extraction.

**AC:** ≥ 3 reference test images (Kahramaa-style bill mock, handwritten account details, QR) each produce a correct confirmation card; deliberately blurry image produces clarification, not a wrong prefill.

### M6 — Excel Bulk Transactions

**Template columns (per MVP Scope §7):** Recipient Name* · Account/Wallet Reference* · Amount QAR* · Purpose · Reference/Invoice No.

**Pipeline:** document webhook → download → SheetJS parse → row validator:
- blank required fields, malformed references, non-positive amounts, per-row txn limit, batch total vs. balance, duplicate (name+ref+amount) detection, high-value flag (> QAR 1,000 → marked for review).

**User reply:**

```
📊 Batch Summary — payroll_july.xlsx
Rows: 12 | Valid: 10 | Errors: 2
Total: QAR 8,450.00 | Fees: QAR 0.00
⚠️ Row 4: missing account reference
⚠️ Row 9: duplicate of row 2
[Approve 10 valid rows] [Download error report] [Cancel]
```

→ OTP → per-row processing → batch receipt + row-level status file (xlsx returned in chat).

**AC:** 200-row file validates ≤ 15s; error rows never process; batch receipt totals reconcile with ledger; dashboard shows the batch with row statuses.

### M7 — OTP/PIN Confirmation Service

- 6-digit OTP delivered **in the same WhatsApp chat** (demo simplification — state this in the demo; production would use SMS/second factor). Optionally show OTP on the admin dashboard "OTP console" for the presenter.
- PIN: 4–6 digits set during first payment or via Settings; argon2id hashed; PIN can substitute OTP for payments < QAR 500 (configurable) to show a smoother repeat-payment UX.
- 3 attempts max; 5-minute expiry; consumed challenges cannot be replayed; PIN messages deleted from logs (store only `****`).
- Required for: payments, batch approval, PIN change, freeze/unfreeze (per MVP Scope §8).

**AC:** Replay of an old OTP fails; expired OTP fails; audit event for every issue/verify/fail.

### M8 — Receipts & Transaction History

- Receipt number `RCP-YYYY-NNNNNN`; chat receipt (formatted text) immediately, optional branded PDF attached (Guild Navy/Blue/Orange branding, reuse Guild doc pipeline aesthetics).
- `HISTORY` → last 5 with statuses; "receipt 3" or "resend receipt" fetches by index/last.
- Batch receipts summarize totals + attach row-status xlsx.

**AC:** Every completed transaction has exactly one receipt; receipt retrievable via AI support ("send me my last receipt").

### M9 — AI Support in WhatsApp

Coverage (per MVP Scope §6.6): account, funding, payments, bills, receipts, bulk upload help, QID questions, security, failed transactions.
- Tool-calling agent (see §6.2c) with user-context injection.
- Freeze flow: "freeze my account" → confirmation + OTP → `accounts.status = frozen` → confirmation + how to unfreeze.
- Escalations create a `support_tickets` row with `status = escalated` visible in dashboard (demo shows the escalation path exists).

**AC:** The 10 scripted demo questions (see §11) all answered correctly with live user data; freeze works end-to-end; out-of-scope question ("give me a loan") politely declines and states scope.

### M10 — Admin / Partner Demo Dashboard

**Pages:**
1. **Overview** — live counters (users, transactions today, volume QAR, support resolution rate) + real-time activity feed (Supabase Realtime).
2. **Users** — profile, QID expiry (highlight expiring < 60 days), language, status, onboarding funnel step; actions: credit demo funds, freeze/unfreeze, resend welcome.
3. **Accounts/Ledger** — balances, ledger entries, reconciliation status.
4. **Transactions** — filterable by status/channel; drill-in shows AI extraction JSON, confirmation trail, receipt link. *(Channel column is a great demo moment: text/voice/image/excel side by side.)*
5. **Bulk Payments** — batches, row statuses, error report download.
6. **AI Support** — question/answer log, categories, escalations.
7. **Risk/Exceptions** — failed OTPs, duplicates, high-value flags, reconciliation drift.
8. **OTP Console** (demo-only, toggleable) — shows active OTPs so the presenter never gets stuck.

**Auth:** Supabase email auth, two roles (admin, viewer). Partner-safe "viewer" mode hides OTP console and PII (masked QID).

**AC:** A payment made on stage appears in the dashboard feed within 2s without refresh.

---

## 8. API Surface (Internal REST)

All external interaction is via WhatsApp; the REST API serves the dashboard and system jobs. Prefix `/v1`, JWT (Supabase) auth, admin role enforced.

| Method & Path | Purpose |
|---|---|
| `POST /webhooks/whatsapp` | Meta webhook receiver (signature-verified, public) |
| `GET  /webhooks/whatsapp` | Meta verification challenge |
| `GET  /v1/users` · `GET /v1/users/:id` | Dashboard user list/detail |
| `POST /v1/users/:id/freeze` · `/unfreeze` | Admin account controls |
| `POST /v1/accounts/:id/credit` | Admin demo funding `{amount, note}` |
| `GET  /v1/transactions` (filters: status, channel, dates) | Transactions panel |
| `GET  /v1/transactions/:id` | Detail incl. extraction + audit trail |
| `GET  /v1/batches` · `GET /v1/batches/:id` · `GET /v1/batches/:id/report` | Bulk panel |
| `GET  /v1/support-tickets` | Support panel |
| `GET  /v1/audit` (filters) | Audit browser |
| `GET  /v1/metrics/overview` | Dashboard counters |
| `POST /v1/demo/reset` | Wipe demo data & reseed (guarded, invaluable between rehearsals) |
| `GET  /v1/otp/active` | OTP console (admin-only, feature-flagged) |

**PartnerAdapter interface (the future integration seam):**

```ts
interface PartnerAdapter {
  createAccount(user: UserProfile): Promise<AccountRef>;
  getBalance(ref: AccountRef): Promise<Money>;
  credit(ref: AccountRef, amt: Money, meta: TxnMeta): Promise<PartnerTxn>;
  transfer(from: AccountRef, to: RecipientRef, amt: Money, meta: TxnMeta): Promise<PartnerTxn>;
  getTransactionStatus(id: string): Promise<TxnStatus>;
}
// MVP: MockPartnerAdapter (Postgres ledger). Later: OoredooMoney / bank / PSP adapter.
```

---

## 9. Security & Controls (implementation of MVP Scope §8)

| Control | Implementation |
|---|---|
| AI cannot complete transactions | State machine enforces `pending_otp → completed` only via OtpService.verify(); LLM has no tool that transitions status. Covered by integration test `no-otp-no-money.spec`. |
| Webhook authenticity | Verify `X-Hub-Signature-256` HMAC with app secret; reject otherwise. |
| Transport & secrets | TLS everywhere; secrets in Railway/host env vault; no secrets in repo; separate keys per environment. |
| PIN storage | argon2id, per-user salt; never logged; masked in message log. |
| QID handling | Encrypted at rest (pgcrypto column encryption); masked everywhere in UI; full value visible only via explicit admin action, audited. |
| Session timeout | Redis TTL + sensitive-flow 5-min inactivity cancel. |
| Limits | Per-transaction (QAR 2,000), daily (QAR 5,000), batch (QAR 20,000), configurable per account; enforced pre-OTP. |
| Rate limiting | Per-phone message throttling (20/min), LLM call caps, OTP request cooldown (60s). |
| Audit | `audit_events` on every sensitive event: draft created, summary shown, OTP issued/verified/failed, ledger posted, freeze, admin credit, escalation. |
| Freeze | User-initiated (chat + OTP) or admin; frozen accounts can only chat with support. |
| Error handling | Every failure state has a user-facing message + `failure_reason` stored; no silent failures. |
| Prompt-injection hygiene | Extraction prompts treat user/image/spreadsheet content as data; tool allow-list per agent; support agent cannot call ledger-mutating tools except freeze/PIN-reset initiators (which still require OTP). |
| Demo data policy | Only test QIDs/synthetic users in demo DB; `POST /v1/demo/reset` before each rehearsal; note in incubation pack that no real customer data is processed pre-license. |

**Regulatory posture (for the incubation narrative):** the MVP moves no real funds and is presented as a technology demonstration. Production requires operating under a QCB-licensed partner (PSP/wallet) — the PartnerAdapter seam and the audit/limits architecture are the evidence of integration readiness. Flag early conversations with QCB sandbox and QFC/QSTP advisors as the licensing path.

---

## 10. Implementation Plan — 4-Week Build

Assumes 1 senior full-stack engineer (David or lead dev) + optionally 1 support dev for the dashboard. All weeks end with a recorded checkpoint demo.

### Week 0 (pre-work, 1–2 days)
- Day-1 accounts checklist (§3.1) — **Meta business verification submitted first**.
- Monorepo scaffold, CI (GitHub Actions: lint, typecheck, test), Docker Compose (api, redis, postgres for local), Supabase schema migration via `drizzle`/`prisma migrate`.
- Twilio sandbox wired as fallback channel behind a `ChannelAdapter` interface (same seam pattern as PartnerAdapter).

### Week 1 — Foundation & Onboarding
| Day | Deliverable |
|---|---|
| 1–2 | Webhook receiver + signature verification + message normalizer + outbound sender (text, buttons, media). Echo bot live on test number. |
| 2–3 | Redis session store + state machine skeleton + global keywords. |
| 3–4 | M1 onboarding flow complete (language, profile, QID validation, consent). |
| 4–5 | M2 ledger service + PartnerAdapter(Mock) + FUND/BALANCE + dashboard skeleton (Users page, credit action). |

**Exit criteria:** onboarding + funding demo recorded; user visible in dashboard.

### Week 2 — Payments Core
| Day | Deliverable |
|---|---|
| 1–2 | AI Orchestrator: intent classifier + text extraction with Zod validation + clarification loop. |
| 2–3 | M3 text payment flow: confirmation card, edit/cancel. |
| 3–4 | M7 OTP/PIN service + `no-otp-no-money` test suite. |
| 4–5 | M8 receipts + HISTORY + Transactions dashboard page. |

**Exit criteria:** end-to-end text payment with OTP and receipt, on video.

### Week 3 — Multimodal
| Day | Deliverable |
|---|---|
| 1–2 | Voice pipeline (media download → Whisper → intent) = M4. |
| 2–3 | Snap-to-pay: QR decode + Claude vision extraction + review/edit step = M5. |
| 3–5 | Excel pipeline: template, SheetJS parser, validator, batch approval, per-row processing, batch receipt + error report = M6. Bulk dashboard page. |

**Exit criteria:** all four input channels produce completed, receipted transactions.

### Week 4 — Support, Polish, Demo Hardening
| Day | Deliverable |
|---|---|
| 1–2 | M9 AI support agent (FAQ corpus, tools, freeze, escalation) + Support dashboard page. |
| 2 | QID expiry reminder job (daily cron; demo trigger button on dashboard) + low-balance alert. |
| 3 | Dashboard Overview (live feed), Risk panel, OTP console, demo reset endpoint, viewer role. |
| 3–4 | Arabic pass: onboarding strings, confirmation cards, support answers spot-checked by a native reader. |
| 4–5 | Full demo rehearsals ×3 with reset between runs; fix list; record 7–10 min demo video; screenshot pack for the submission deck. |

**Exit criteria:** MVP Success Criteria (§14 of MVP Scope) all green; demo video exported.

### Buffer & de-risking
- If Meta verification/display-name review slips: demo on Twilio sandbox (join-code caveat is acceptable for incubation panels) — decision point end of Week 1.
- If Arabic STT quality disappoints: demo voice in English, show Arabic text flows, note Arabic voice as a hardening item.
- Highest-risk module is M5 image extraction variability → lock 3 curated demo images early and tune against them.

### Suggested Linear structure (INFRASTRUCTURE workspace pattern)
Team **GuildPay (GPY)** · Projects: `GPY-Foundation`, `GPY-Payments`, `GPY-Multimodal`, `GPY-Support-&-Dashboard`, `GPY-Demo-&-Submission` · Cycles = the 4 build weeks · Labels: `flow:m1…m10`, `risk`, `demo-blocker`. I can generate the full issue set (≈60 issues with descriptions and ACs) into Linear on request.

---

## 11. Demo Runbook (7–10 minutes, maps to MVP Scope §5)

**Setup (before panel):** demo reset run; two phones (presenter + "reviewer" volunteer); dashboard on projector in viewer-safe mode with OTP console on presenter laptop only; pre-staged assets: bill photo printed, `payroll_demo.xlsx` (10 rows, 2 deliberate errors) on the phone; QID in test profile set to expire in 30 days so the reminder fires naturally.

| Min | Beat | Script cue |
|---|---|---|
| 0:00 | QR scan → onboarding | "Everything you'll see happens inside WhatsApp — no app download." |
| 1:30 | Account issued + admin credits QAR 2,000 | Dashboard feed shows the credit landing live. |
| 2:30 | Text payment + OTP + receipt | "The AI prepares — only the customer's OTP completes." |
| 3:30 | Voice note payment (English) | Show transcript echo → summary → PIN. |
| 4:30 | Snap-to-pay with printed bill | Extraction card, correct one field via Edit to show human-in-the-loop. |
| 6:00 | Excel batch | Show the 2 flagged errors — "the system protects the business from its own spreadsheet." Approve 8 rows → batch receipt. |
| 7:30 | AI support | "Resend my last receipt" · "Why would a payment fail?" · "Freeze my account" (OTP → frozen → dashboard flips status). |
| 8:30 | QID reminder + dashboard tour | Users → Transactions (channel column) → Bulk → Risk panel. |
| 9:30 | Close | "Mock ledger today; PartnerAdapter is the one seam a licensed partner plugs into." |

**Failure drills:** WhatsApp down → play recorded video; LLM slow → deterministic fallback keywords (`PAY 200 AHMED` bypass path built into M3); OTP not arriving → OTP console.

---

## 12. Testing & Quality Plan

| Layer | Approach |
|---|---|
| Unit | Validators (QID, amounts, Excel rows), ledger math, OTP lifecycle, state transitions. Target: ledger + OTP at 100% branch coverage. |
| Integration | Simulated webhook payload fixtures for every message type; golden-path tests for M1–M9; `no-otp-no-money.spec` as a release gate. |
| AI eval set | 40 utterances (EN/AR, misspellings, mixed language, missing fields) with expected JSON → run on every prompt change; extraction accuracy target ≥ 90% on the set, 100% on the 12 demo utterances. |
| Vision eval | The 3 demo images + 5 adversarial (blur, glare, cropped) — adversarial must produce clarifications, never wrong prefills. |
| Load sanity | 20 concurrent simulated users; webhook p95 < 500ms ack (process async). |
| UAT | David's partner + 2 Guild Academy testers run the full journey cold, on their own phones, in Week 4 Day 3. |
| Rehearsals | 3 full runs with demo reset; every hiccup becomes a `demo-blocker` issue. |

---

## 13. Environments, Ops & Repo Layout

```
guildpay/
├─ apps/
│  ├─ api/           # NestJS: gateway, flows, orchestrator, ledger, jobs
│  └─ dashboard/     # Next.js 14
├─ packages/
│  ├─ shared/        # zod schemas, types, constants (single source of truth)
│  └─ prompts/       # versioned prompt files + eval sets
├─ infra/            # docker-compose, deploy scripts
└─ docs/             # this PRD, runbook, template xlsx, FAQ corpus
```

- **Environments:** `local` (compose + tunnels) · `demo` (production-like, the one used on stage). No separate staging at MVP.
- **Config:** all behavior flags in env/DB config: limits, PIN-instead-of-OTP threshold, OTP console toggle, language list, LLM models per route.
- **Backups:** Supabase daily; export demo seed as SQL so any environment reproduces the exact stage state.
- **Runbooks:** deploy, rollback, demo reset, webhook re-subscribe, key rotation.

---

## 14. Budget & Resourcing Snapshot

| Item | 4-week MVP estimate |
|---|---|
| Engineering (1 senior FS, 4 wks) | In-house (David) or QAR 25k–40k contracted |
| Dashboard support dev (optional, 2 wks) | QAR 8k–12k |
| Infra + APIs (2 months) | QAR 600–1,100 (~$150–300) |
| WhatsApp display-name/branding assets | Existing Guild pipeline |
| Contingency | 15% |

This sits comfortably inside the business plan's QAR 1.2–1.8M 12–18-month envelope; the MVP consumes < 5% of it while producing the incubation submission's centerpiece.

---

## 15. Post-MVP Milestones (next 90 days after demo)

1. **Partner integration spike:** implement `PartnerAdapter` against one target (QCB-licensed PSP/wallet sandbox); success = one real QAR 1 transfer in sandbox.
2. **Real second-factor:** SMS OTP via local aggregator; device binding exploration.
3. **Pilot cohort:** 25–50 users (Guild network + one SME for bulk payments), instrumented funnel: onboarded → funded → first txn → repeat txn (activation metrics the business plan promises partners).
4. **Compliance workstream:** QCB sandbox application, KYC vendor evaluation, data-residency plan (natural tie-in: hosting on Guild Server for the sovereignty narrative).
5. **Merchant payment-request flow** (send a pay-link/QR from chat) — the first B2B revenue feature.

---

## 16. Requirements Traceability

| MVP Scope item | Covered in |
|---|---|
| §2 Functional definition (8 areas) | Modules M1–M10, §7 |
| §4 Ten modules | §7 (1:1) |
| §5 Demo flow | §11 runbook |
| §6 User flows 6.1–6.6 | M1, M3, M4, M5, M6, M9 |
| §7 Excel template | M6 + `docs/template.xlsx` |
| §8 Security rules | §9 controls table |
| §9 Dashboard areas | M10 pages 1–8 |
| §10 Suggested architecture | §2 (extended with adapters, jobs, audit) |
| §11 Timeline | §10 (week-by-week with exit criteria) |
| §13 Submission package | Demo video + screenshots (Wk4), this PRD = "MVP build scope" artifact, architecture diagram (§2.1) |
| §14 Success criteria | §10 Week-4 exit + §12 UAT |

---

*Prepared for Guild Technologies LLC. Confidential working document.*
