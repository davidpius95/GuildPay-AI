# GuildPay AI — Build Plan (work through this in order)

Check off items as they land. Each week ends with a recorded checkpoint demo.
Full acceptance criteria for each module are in `docs/01_TECHNICAL_PRD.md` §7.

## Week 0 — Setup (1–2 days)
- [ ] Create accounts: Meta Business + WhatsApp app (test number), Anthropic, OpenAI, Supabase, Upstash, Railway, domain
- [ ] **Submit Meta business verification (do this first — longest lead time)**
- [ ] Monorepo scaffold: `apps/api`, `apps/dashboard`, `packages/shared`; CI (lint, typecheck, test)
- [ ] Docker Compose for local (api, postgres, redis); Supabase schema migration tool wired
- [ ] Twilio Sandbox wired behind `ChannelAdapter` as fallback

## Week 1 — Foundation
- [ ] Webhook receiver + signature verification + message normalizer + outbound sender (echo bot live)
- [ ] Redis session store + conversation state machine skeleton + global keywords (CANCEL/BALANCE/HELP)
- [ ] **M1** WhatsApp onboarding (language, name, QID validation, consent)
- [ ] **M2** Demo wallet ledger + `PartnerAdapter(Mock)` + FUND/BALANCE + dashboard Users page
- [ ] ✅ Checkpoint: onboarding + funding demo recorded

## Week 2 — Payments core
- [ ] AI Orchestrator: intent classifier + text extraction (zod-validated) + clarification loop
- [ ] **M3** Text payment flow (confirmation card, edit/cancel)
- [ ] **M7** OTP/PIN service + `no-otp-no-money` test suite (release gate)
- [ ] **M8** Receipts + HISTORY + Transactions dashboard page
- [ ] ✅ Checkpoint: end-to-end text payment with OTP + receipt on video

## Week 3 — Multimodal
- [ ] **M4** Voice pipeline (media download → Whisper → intent)
- [ ] **M5** Snap-to-pay (QR decode + Claude vision extraction + review/edit step)
- [ ] **M6** Excel bulk: template parser (SheetJS) + row validator + batch approval + batch receipt + error report
- [ ] Bulk dashboard page
- [ ] ✅ Checkpoint: all four input channels produce completed, receipted transactions

## Week 4 — Support, polish, demo hardening
- [ ] **M9** AI support agent (FAQ corpus, tools, freeze, escalation) + Support dashboard page
- [ ] QID expiry reminder job + low-balance alert (+ dashboard trigger button)
- [ ] **M10** Dashboard Overview (live feed), Risk panel, OTP console, `/v1/demo/reset`, viewer role
- [ ] Arabic pass on onboarding + confirmation cards + support answers
- [ ] 3 full rehearsals with demo reset between runs; record 7–10 min demo video + screenshot pack
- [ ] ✅ Checkpoint: all MVP success criteria green (PRD §14)
