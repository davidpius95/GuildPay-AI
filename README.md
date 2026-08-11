# GuildPay AI — WhatsApp-Native AI Neobank

GuildPay AI is a **WhatsApp-native, AI-powered financial assistant** — a complete wallet and neobank that lives entirely inside WhatsApp. Users can perform everyday financial operations (sending money, bank transfers, checking balances, buying airtime/data) through conversational natural language, voice notes, or photos. 

This repository houses the NestJS-based API backend (`apps/api`), the Next.js administration dashboard (`apps/dashboard`), and shared utilities (`packages/shared`).

---

## 📖 Table of Contents
1. [System Overview & Markets](#1-system-overview--markets)
2. [End-to-End Architecture](#2-end-to-end-architecture)
3. [Core Integration & Connection Mechanics](#3-core-integration--connection-mechanics)
   - [WhatsApp Webhook Integration](#whatsapp-webhook-integration)
   - [Flutterwave Integration (NGN Rail)](#flutterwave-integration-ngn-rail)
   - [AI & Speech-to-Text Pipeline](#ai--speech-to-text-pipeline)
   - [Database & Double-Entry Ledger](#database--double-entry-ledger)
4. [Local Setup & Running](#4-local-setup--running)
5. [Server Deployment](#5-server-deployment)
6. [Security Invariants & Guardrails](#6-security-invariants--guardrails)

---

## 1. System Overview & Markets

GuildPay operates on a unified ledger schema catering to two primary markets:
*   **NGN (Nigeria)**: Flagship rail integrated with the Flutterwave sandbox. Features automated BVN/KYC validation formats, instant virtual NUBAN account provisioning, automatic ledger credit on deposits, name enquiry validation, and bank payouts (NIP).
*   **QAR (Qatar)**: Closed-loop, simulated double-entry wallet for peer-to-peer (P2P) transfers and internal operations.

The user experience relies on a **state-machine first, LLM second** approach. The conversational flow is strictly deterministic for critical operations (onboarding, security confirmations, OTP prompts) and uses LLM intent parsing only to understand free-form requests.

---

## 2. End-to-End Architecture

```
                       ┌────────────────────────┐
                       │   WhatsApp User Client │
                       └───────────┬────────────┘
                                   │ (Text, Voice, Buttons)
                                   ▼
                       ┌────────────────────────┐
                       │ Meta WhatsApp Cloud API│
                       └───────────┬────────────┘
                                   │ HTTPS POST (X-Hub-Signature-256)
                                   ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │                        Your Guild Server (Ubuntu)                       │
   │                                                                         │
   │  ┌───────────────────┐      ┌────────────────┐      ┌────────────────┐  │
   │  │ Cloudflare Tunnel │ ───► │ Traefik Router │ ───► │   NestJS API   │  │
   │  └───────────────────┘      └────────────────┘      │   (apps/api)   │  │
   └─────────────────────────────────────────────────────┴───────┬────────┘  │
                                                                 │           │
       ┌──────────────────────────────┬──────────────────────────┼───────────┤
       ▼                              ▼                          ▼           ▼
 ┌───────────┐                  ┌───────────┐              ┌───────────┐ ┌───────┐
 │ WhatsApp  │                  │Onboarding │              │  Message  │ │Redis  │
 │Controller │                  │  Service  │              │  Router   │ │Session│
 └─────┬─────┘                  └─────┬─────┘              └─────┬─────┘ └───────┘
       │                              │                          │
       │ (Queue Event)                │ (Create User/Wallet)     ├───────────┐
       ▼                              ▼                          ▼           ▼
 ┌───────────┐                  ┌───────────┐              ┌───────────┐ ┌───────┐
 │  Channel  │                  │Partner /  │              │Orchestrator││  AI   │
 │  Adapter  │                  │  Ledger   │              │  Service  │ │Service│
 └─────┬─────┘                  └─────┬─────┘              └─────┬─────┘ └───┬───┘
       │                              │                          │           │
       │ (JSON Intent Extraction)     │ (Double-Entry ledger)    │           ▼
       │                              ▼                          │     ┌───────────┐
       │                        ┌───────────┐                    │     │   Groq    │
       │                        │ Supabase  │ ◄──────────────────┘     │ (Llama 3) │
       │                        │ Postgres  │                          └─────┬─────┘
       ▼                        └───────────┘                                │ (Fallback)
 ┌───────────┐                                                               ▼
 │ WhatsApp  │                                                         ┌───────────┐
 │ Outbound  │                                                         │  Gemini   │
 └───────────┘                                                         │ (Flash2.0)│
                                                                       └───────────┘
```

---

## 3. Core Integration & Connection Mechanics

### WhatsApp Webhook Integration
All inbound text, interactive buttons, and media (voice notes/photos) land on `POST /webhooks/whatsapp`.
1.  **Verification (Handshake)**: Meta verifies the endpoint via a `GET` handshake using a matching `META_WEBHOOK_VERIFY_TOKEN`.
2.  **Signature Checking**: Meta signs payloads using `HMAC-SHA256` computed with your `META_APP_SECRET`. The API validates this in `X-Hub-Signature-256` before parsing.
3.  **Twilio Fallback**: If Meta credentials aren't ready, the API can switch to a Twilio adapter by modifying `CHANNEL_ADAPTER=twilio`.

### Flutterwave Integration (NGN Rail)
Outbound money movement and virtual accounts run through `FlutterwavePartnerAdapter`:
*   **Virtual NUBAN Provisioning**: On completing onboarding, a request is sent to `POST /v3/virtual-account-numbers` to map the user's name and BVN to a virtual bank account.
*   **Deposits & Funding**: When funds land in the user's NUBAN, Flutterwave fires `charge.completed` to `POST /webhooks/flutterwave`. The webhook verifies authenticity by checking the constant-time `verif-hash` header against `FLW_WEBHOOK_SECRET_HASH`, queries `GET /v3/transactions/:id/verify` to prevent payload tampering, and atomically updates the ledger.
*   **Name Enquiry**: Before any external bank payout (NIP), `POST /v3/accounts/resolve` is queried with the destination account number and bank code. The resolved name is displayed to the user for validation.
*   **Outbound Bank Transfer (NIP)**: Executed via `POST /v3/transfers`. If the transaction fails, an automated refund is triggered to restore the user's balance on the double-entry ledger.

### AI & Speech-to-Text Pipeline
*   **Intent Extraction**: Natural language queries are forwarded to `OrchestratorService`. An LLM intent-parser uses structured JSON output (validated via `zod`) to extract `intent` (e.g., `p2p_transfer`, `bank_transfer`, `balance`), `amount`, `recipient`, and `bank_code`.
*   **Multi-Provider Fallback**: Defined by `AI_PROVIDER_ORDER=groq,gemini`. If Groq (`llama-3.3-70b`) fails or hits rate limits, the request automatically falls back to Google Gemini (`gemini-2.0-flash`).
*   **Speech-to-Text (STT)**: User voice notes are downloaded from Meta's media API, stored temporarily, and sent to OpenAI Whisper (or a self-hosted `faster-whisper` endpoint set by `STT_LOCAL_URL`) before being injected into the routing pipeline as text.

### Database & Double-Entry Ledger
All transaction history lives in a Supabase-managed Postgres 16 instance:
*   **Double-Entry Pattern**: Every transaction maps to two `ledger_entries` (a debit and a credit) executing inside an atomic database transaction. Balance updates use conditional updates: `UPDATE wallets SET balance = balance - amount WHERE id = :id AND balance >= :amount`.
*   **Security Ledger**: Verification OTPs are generated, hashed, stored in `otp_challenges`, and checked deterministically without LLM intervention.

---

## 4. Local Setup & Running

### Prerequisites
*   **Node.js 20** + **pnpm** (v9+)
*   **Redis** (running locally or via Docker)
*   **Postgres** database (Supabase schema applied)

### 1. Environment Configuration
Copy the template configuration and fill in the credentials:
```bash
cp .env.example .env
```

Key variables in `.env` include:
*   `AI_PROVIDER_ORDER`: Fallback chain (e.g., `groq,gemini`).
*   `GROQ_API_KEY`, `GEMINI_API_KEY`: Model provider keys.
*   `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`: Meta Developer credentials.
*   `META_WEBHOOK_VERIFY_TOKEN`: Random token you configure on Meta.
*   `DATABASE_URL`: Connection string for Postgres.
*   `REDIS_URL`: Endpoint for Redis caching (`redis://localhost:6379`).
*   `FLW_SECRET_KEY`, `FLW_WEBHOOK_SECRET_HASH`: Flutterwave API key and secret signature.

### 2. Database Migrations
Deploy the base database structure to your Postgres instance:
```bash
pnpm migrate
```

### 3. Start the Services
Run the NestJS API and Next.js Dashboard concurrently in development mode:
```bash
pnpm dev
```

### 4. Running Tests
Verify state invariants and system rules (such as `no-otp-no-money`):
```bash
pnpm test
```

---

## 5. Server Deployment

GuildPay AI is self-hosted on your Guild Server box using Docker, Traefik, and a Cloudflare Tunnel under the production domain: `guildpay.guild-technologies.com`.

### 1. Setup Environment
SSH to your server and configure the environment:
```bash
ssh -p 5555 usher-node@143.105.102.121
cd ~/apps/guildpay
cp .env.production.example .env
nano .env # Fill in live production configuration keys
```

### 2. Start Application Stack
Bring the Docker containers online:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### 3. Diagnostic Logs
```bash
docker compose -f docker-compose.prod.yml logs -f guildpay-api
```

### 4. Public Endpoint Health Check
```bash
curl https://guildpay.guild-technologies.com/health
# Response: {"status":"ok",...}
```

---

## 6. Security Invariants & Guardrails

To protect financial integrity, the application code strictly enforces four primary guardrails:
1.  **No OTP, No Money (`no-otp-no-money`)**: The AI can parse intents and *prepare* transactions, but it is structurally impossible to complete a transaction without a verified OTP. Only `OtpService.verify()` can transition transactions to a completed state.
2.  **Enquiry-Before-Payout**: Outbound bank payouts (NIP) require a preceding name enquiry. Payout is blocked if the target account cannot be resolved.
3.  **Strict Webhook Verification**: Constant-time signature matching is enforced on webhook endpoints to prevent replay attacks and spoofed webhook calls.
4.  **No BVN / PII Logging**: Logs automatically strip out sensitive inputs like BVN numbers, phone numbers, and full virtual account references.
