# GuildPay AI — Project Context (CLAUDE.md)

> This file is read automatically at the start of every session by **Claude Code**
> and by **Google Antigravity** (which also reads CLAUDE.md-style ambient context).
> Keep it short and current. It is the single source of truth for how to build this project.

## WHY — what we're building
GuildPay AI is a **WhatsApp-native, AI-powered financial assistant** — a full **wallet / neobank that
lives inside WhatsApp**. A user creates a virtual account and does **every everyday money action** —
send to a user, transfer to any bank, buy airtime/data, pay bills, save — **by talking to the AI** in
natural language, voice notes, or photos. No app, no forms. Same category as **Xara** (usexara.ai).
This repo is the **4-week, incubation-ready MVP**. **The product is the conversation.**

**Two co-equal markets**, both behind the same adapter interfaces:
- **NGN (Nigeria)** — flagship rail. Virtual NUBAN accounts, bank payout (NIP), airtime/data/bills via
  **Flutterwave sandbox**. Full feature set.
- **QAR (Qatar)** — **simulated double-entry ledger**; wallet + P2P + internal transfer subset.

Money model: **sandbox / simulated test money only, architected real-ready** (swap adapters + live
keys + a licensed partner later — no rewrite). Currency chosen at onboarding selects the rail; flows
are currency-agnostic. The OTP/PIN gate applies identically everywhere.

Full detail lives in `/docs`. Read these before planning work:
- `docs/00_VISION_AND_ARCHITECTURE.md` — **north star**: vision, Xara reference, architecture, markets
- `docs/01_TECHNICAL_PRD.md` — architecture, data model, APIs, security, module specs, 4-week plan
- `docs/02_IMPLEMENTATION_GUIDE.md` — plain-English overview + diagrams + user journeys
- `docs/03_MVP_SCOPE.md` — the exact capabilities the demo must prove
- `docs/04_BUILD_PLAN.md` — the task checklist you work through, in order
- `docs/05_SETUP_AND_DEPLOY.md` — accounts, API keys, env vars, webhooks, deployment

## WHAT — the stack (do not deviate without asking)
- **Runtime:** Node.js 20 + TypeScript, **NestJS**
- **Messaging:** Meta WhatsApp Cloud API (Twilio Sandbox as fallback) behind a `ChannelAdapter`
- **AI:** Anthropic Claude API (intent + vision) + OpenAI Whisper (voice→text)
- **DB:** **Supabase** (Postgres 16 system of record + ledger, Storage for media, Auth for the dashboard).
  Use the **self-hosted Supabase already running on the Guild Server** (or Supabase cloud). Access
  Postgres via `DATABASE_URL`; use the service-role key server-side only.
- **Cache/session:** Redis
- **Dashboard:** Next.js 14 + shadcn/ui + Recharts
- **Capability modules** (one per action): `onboarding`, `fund`, `balance`, `transfer` (P2P),
  `bank-transfer` (NIP), `airtime`, `data`, `bills`, `savings`, `request-money`, `history`,
  `spending-insights`, `support`. All currency-aware and OTP/PIN-gated.
- **Money abstractions:**
  - **`WalletService`** — internal multi-currency double-entry ledger; source of truth for balances.
  - **`PartnerAdapter`** (per currency, via `PartnerService.forCurrency`) — external settlement +
    accounts: NGN → `FlutterwavePartnerAdapter` (virtual NUBAN, name enquiry, NIP payout, fund
    webhook `verif-hash`); QAR → `MockPartnerAdapter` (simulated).
  - **`BillsAdapter`** (VTU, via `BillsService`) — NGN → `FlutterwaveBillsAdapter` (airtime/data/bills).
- **Hosting:** self-hosted on Guild Server (Docker + Traefik + Cloudflare Tunnel → guildpay.guildserver.io)

## HOW — conventions & guardrails
- **Monorepo:** `apps/api` (NestJS), `apps/dashboard` (Next.js), `packages/shared` (zod schemas + types).
- **State-machine first, LLM second.** Deterministic flows (onboarding steps, OTP entry, button
  confirmations) must NOT depend on the LLM. The LLM only interprets free-form content.
- **The AI can PREPARE a transaction but NEVER COMPLETE one.** Only the OTP/PIN verifier may move a
  transaction from `pending_otp → completed`. There must be a passing test `no-otp-no-money`.
- **All money movement goes through the money abstractions** — `WalletService` (ledger),
  `PartnerAdapter` (resolve via `PartnerService.forCurrency`), and `BillsAdapter` (via `BillsService`).
  Never call the ledger, Flutterwave, or any provider SDK directly from a capability module.
- **Before any bank payout (NIP): name enquiry first** — resolve and show the recipient account name
  in the confirmation card. Never send to an unverified account number.
- **Every LLM extraction returns validated JSON** (zod). On validation failure: one retry, then ask a
  clarifying question — never guess an amount, recipient, or biller.
- **Secrets** come from environment variables only (see `.env.example`). Never hardcode keys. Never log
  PINs, OTPs, BVN, or full QID / NUBAN numbers.
- **Every sensitive action writes an `audit_events` row.**
- TypeScript strict mode. Prefer named exports. One feature per module.

## Commands (fill in as the project takes shape)
- `pnpm dev` — run api + dashboard locally
- `pnpm test` — run all tests (must include `no-otp-no-money`)
- `pnpm lint` / `pnpm typecheck`
- `pnpm migrate` — apply Supabase (Postgres) schema migrations

## Working style for the agent
Follow **Explore → Plan → Implement → Verify → Commit**:
1. Read the relevant `/docs` section and the current `docs/04_BUILD_PLAN.md` item.
2. Propose a short plan and **wait for approval** before writing code.
3. Implement the smallest shippable slice; write/adjust tests.
4. Run tests + lint; show what changed.
5. Commit with a clear message referencing the build-plan item (e.g. `M3: text payment flow`).

Do one build-plan item at a time. Do not skip ahead. If a step is ambiguous, ask.
