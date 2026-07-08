# GuildPay AI — Project Context (CLAUDE.md)

> This file is read automatically at the start of every session by **Claude Code**
> and by **Google Antigravity** (which also reads CLAUDE.md-style ambient context).
> Keep it short and current. It is the single source of truth for how to build this project.

## WHY — what we're building
GuildPay AI is a **WhatsApp-native QAR payment assistant for Qatar**. Users onboard, get a
demo QAR wallet, and pay locally by **text, voice note, photo, or Excel upload**, confirming
with **OTP/PIN** and receiving a receipt — all inside WhatsApp. This repo is the **4-week,
incubation-ready MVP** built on a **simulated ledger** (no real money moves yet).

Full detail lives in `/docs`. Read these before planning work:
- `docs/01_TECHNICAL_PRD.md` — architecture, data model, APIs, security, module specs, 4-week plan
- `docs/02_IMPLEMENTATION_GUIDE.md` — plain-English overview + diagrams + 3 user journeys
- `docs/03_MVP_SCOPE.md` — the exact features the demo must prove
- `docs/04_BUILD_PLAN.md` — the task checklist you work through, in order

## WHAT — the stack (do not deviate without asking)
- **Runtime:** Node.js 20 + TypeScript, **NestJS**
- **Messaging:** Meta WhatsApp Cloud API (Twilio Sandbox as fallback) behind a `ChannelAdapter`
- **AI:** Anthropic Claude API (intent + vision) + OpenAI Whisper (voice→text)
- **DB:** PostgreSQL via **Supabase** (system of record + file storage + dashboard auth)
- **Cache/session:** Redis (Upstash)
- **Dashboard:** Next.js 14 + shadcn/ui + Recharts
- **Ledger:** double-entry demo ledger in Postgres behind a `PartnerAdapter` interface
- **Hosting:** Railway (or Hetzner + Docker)

## HOW — conventions & guardrails
- **Monorepo:** `apps/api` (NestJS), `apps/dashboard` (Next.js), `packages/shared` (zod schemas + types).
- **State-machine first, LLM second.** Deterministic flows (onboarding steps, OTP entry, button
  confirmations) must NOT depend on the LLM. The LLM only interprets free-form content.
- **The AI can PREPARE a transaction but NEVER COMPLETE one.** Only the OTP/PIN verifier may move a
  transaction from `pending_otp → completed`. There must be a passing test `no-otp-no-money`.
- **All money movement goes through `PartnerAdapter`** (MVP = MockPartnerAdapter on the Postgres ledger).
  Never call the ledger directly from a flow.
- **Every LLM extraction returns validated JSON** (zod). On validation failure: one retry, then ask a
  clarifying question — never guess a payment amount or recipient.
- **Secrets** come from environment variables only (see `.env.example`). Never hardcode keys. Never log
  PINs, OTPs, or full QID numbers.
- **Every sensitive action writes an `audit_events` row.**
- TypeScript strict mode. Prefer named exports. One feature per module.

## Commands (fill in as the project takes shape)
- `pnpm dev` — run api + dashboard locally
- `pnpm test` — run all tests (must include `no-otp-no-money`)
- `pnpm lint` / `pnpm typecheck`
- `pnpm migrate` — apply Supabase schema migrations

## Working style for the agent
Follow **Explore → Plan → Implement → Verify → Commit**:
1. Read the relevant `/docs` section and the current `docs/04_BUILD_PLAN.md` item.
2. Propose a short plan and **wait for approval** before writing code.
3. Implement the smallest shippable slice; write/adjust tests.
4. Run tests + lint; show what changed.
5. Commit with a clear message referencing the build-plan item (e.g. `M3: text payment flow`).

Do one build-plan item at a time. Do not skip ahead. If a step is ambiguous, ask.
