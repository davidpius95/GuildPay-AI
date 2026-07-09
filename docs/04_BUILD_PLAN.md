# GuildPay AI — Build Plan (work through this in order)

> Serves `docs/00_VISION_AND_ARCHITECTURE.md` (vision) and `docs/03_MVP_SCOPE.md` (capabilities).
> Check off items as they land. Each week ends with a recorded checkpoint demo.
> Full acceptance criteria per module are in `docs/01_TECHNICAL_PRD.md` §7.

## Week 0 — Setup (1–2 days)
- [x] Monorepo scaffold: `apps/api`, `apps/dashboard`, `packages/shared`; CI (lint, typecheck, test)
- [x] Docker Compose for local (api, postgres, redis); prod stack for guildpay.guildserver.io
- [x] `ChannelAdapter` (Meta + Twilio) + `PartnerAdapter`/`BillsAdapter` boundaries stubbed
- [ ] Create accounts: Meta Business + WhatsApp app (test number), Anthropic, STT (OpenAI or self-host),
      Flutterwave (sandbox). **Submit Meta business verification first — longest lead time.**
- [ ] Schema migration tool wired (Postgres)

## Week 1 — Foundation & wallet
- [ ] Webhook receiver + signature verification + message normalizer + outbound sender (echo bot live)
- [ ] Redis session store + conversation state machine skeleton + global keywords (CANCEL/BALANCE/HELP)
- [ ] **M1** Onboarding: language (EN/Pidgin/AR) → profile → **currency/market select** → KYC id
      (BVN for NGN, QID for QAR) → consent → **virtual account created & shown in chat**
- [ ] **M2** `WalletService` (double-entry ledger, multi-currency) + `PartnerAdapter(Mock, QAR)` +
      FUND/BALANCE + dashboard Users page
- [ ] ✅ Checkpoint: onboarding + virtual account + funding (QAR simulated) recorded

## Week 2 — Transaction core + OTP gate
- [ ] AI Orchestrator: **intent classifier** (transfer / bank-transfer / airtime / bill / balance / …)
      + payload extraction (zod-validated) + clarification loop
- [ ] **M3** Send to GuildPay user (P2P): confirmation card, edit/cancel
- [ ] **M7** OTP/PIN service + `no-otp-no-money` test suite covering every capability (release gate)
- [ ] **M8** Receipts + HISTORY + Transactions dashboard page
- [ ] ✅ Checkpoint: end-to-end P2P transfer with OTP + receipt on video

## Week 2.5 — NGN rail live (Flutterwave sandbox)
- [ ] **M2b** `FlutterwavePartnerAdapter`: create **virtual NUBAN**, fund detection via webhook
      (`verif-hash`), `getBalance`
- [ ] **M3b** **Bank transfer (NIP)**: `nameEnquiry` → confirm resolved name → OTP → payout → receipt
- [ ] **M6a** **Airtime / data** via `FlutterwaveBillsAdapter` (`buyAirtime` / `buyData`)
- [ ] **M6b** **Bill payments** (electricity / cable / betting): `validateCustomer` → pay → token/receipt
- [ ] Extend `no-otp-no-money` + `audit_events` to all NGN money actions; dashboard shows currency/rail
- [ ] ✅ Checkpoint: NGN onboarding → funded NUBAN → OTP-confirmed bank transfer, airtime, and a bill

## Week 3 — Multimodal + savings
- [ ] **M4** Voice pipeline (media download → Whisper → intent) across all capabilities
- [ ] **M5** Snap-to-pay (Claude vision: invoice / bank details / meter no / QR → prefilled action)
- [ ] **M9** Savings / target-savings (sub-ledger) + Request money
- [ ] Spending-insights summary + dashboard pages (bills, savings)
- [ ] ✅ Checkpoint: text + voice + photo each drive a completed, receipted transaction; savings goal funded

## Week 4 — Support, polish, demo hardening
- [ ] **M10** AI support agent (FAQ corpus, tools, freeze, escalation) + Support dashboard page
- [ ] Reminder jobs (KYC/QID expiry, low-balance) + dashboard trigger button
- [ ] **M11** Dashboard Overview (live feed), Risk panel, OTP console, `/v1/demo/reset`, viewer role
- [ ] Language pass (Pidgin + Arabic) on onboarding + confirmation cards + support answers
- [ ] 3 full rehearsals with demo reset between runs; record 7–10 min demo video + screenshot pack
- [ ] ✅ Checkpoint: all MVP success criteria green (PRD §14)
