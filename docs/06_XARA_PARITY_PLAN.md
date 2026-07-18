# 06 — Xara Parity Plan

> Roadmap to bring GuildPay AI's WhatsApp experience to parity with **Xara by Xava Tech**,
> derived from the video-analyzer output (`/.agents/skills/video-analyzer/examples/xara_demo_analysis.md`).
> This complements `04_BUILD_PLAN.md` — work is still done **one slice at a time**, tested, and committed.

## Locked decisions
- **WhatsApp access:** full WhatsApp Business API + Meta Business Manager (Flows & Lists will work).
- **PIN entry Flow type:** **encrypted data-exchange endpoint** (RSA keypair + public-key upload to Meta +
  AES-GCM per-screen decryption). Not the simpler endpointless variant.
- **Execution order:** Phase 1 (Flows/PIN) first.

## Open policy questions (do not block Phase 1)
1. **Fee policy** — Xara advertises "30 free transfers/month". Free-tier count? Per-transfer fee after? Always free?
2. **Transaction limits** — daily spending cap + minimum transfer (Xara: ₦100 min). Values?
3. **Welcome video** — send an HD welcome video to new users, or skip for MVP?
4. **Flow ID** — after the PIN Flow is created in WhatsApp Manager, paste its Flow ID into `WHATSAPP_PIN_FLOW_ID`.

## Gap matrix → phase mapping

| Capability | Xara | GuildPay (current) | Gap | Covered by |
|---|---|---|---|---|
| Onboarding UX | 1-click list template | 5-step wizard | 🟡 GuildPay more thorough | Phase 2 (optional List polish) |
| NUBAN provisioning | ✅ Flutterwave MFB | ✅ Flutterwave | ✅ Matched | — |
| Bank transfer (NIP) | ✅ + name enquiry | ✅ + name enquiry | ✅ Matched | — |
| PIN security | Flow modal | Chat-based PIN | 🔴 Major | **Phase 1** |
| Receipt format | Branded image | **Already branded PNG** | ✅ Mostly done | Phase 5 (enrich only) |
| Message templates | Lists + Quick Replies | Reply buttons only | 🟡 Missing lists | Phase 2 |
| Voice notes | ✅ with ack | ✅ no ack | 🟡 Minor | Phase 3 |
| Airtime/data | ✅ live | ❌ stub | 🔴 Feature gap | Phase 4 |
| Transaction history | ✅ formatted | ❌ not built | 🔴 Feature gap | Phase 4 |
| Batch transfers | ✅ text + Excel | ❌ not planned | 🟡 Nice-to-have | Phase 7 (new, backlog) |
| Welcome video | ✅ HD video | ❌ none | 🟡 Polish | Phase 6 (policy Q3) |
| Settings management | ✅ AI-managed | ❌ not built | 🟡 P3 | Phase 6 |
| Support tickets | ✅ auto-ref + reply | ❌ not built | 🟡 P3 | Phase 6 |
| Fee transparency | ✅ "30 free/month" | ❌ none | 🟡 Policy | Phase 5 (policy Q1) |

> Note: the receipt row in the original analysis is **stale** — GuildPay already renders a branded PNG
> (`receipt.service.ts`). Phase 5 only enriches it (provider ref, fee line).

## Phases

### Phase 1 — Encrypted WhatsApp Flow for PIN entry 🔴 (current slice)
- `channel-adapter.ts` — add `OutboundFlow` type.
- `meta-cloud.adapter.ts` — build `interactive.type: 'flow'` body (with `mode: 'draft'` for testing); parse `nfm_reply`.
- **NEW** `whatsapp-flow.service.ts` — RSA keypair load, AES-GCM decrypt/encrypt of the Flow data-exchange payload, signed flow-token tying a response to a `pending_otp` txn.
- **NEW** `POST /webhooks/whatsapp/flow` — the encrypted Flow data endpoint (decrypt → validate → next/complete screen).
- `bank-transfer.service.ts` + `transfer.service.ts` — `confirm()` sends the Flow when `WHATSAPP_PIN_FLOW_ID` is set and the user already has a PIN; **falls back to chat PIN** otherwise. Money still only moves via `submitPin`/`pinGate`.
- **NEW** `docs/whatsapp-flows/pin-flow.json` — the Flow definition to upload in WhatsApp Manager.
- Tests: flow body-building, `nfm_reply` decrypt+parse, and `no-otp-no-money` still holds.

### Phase 2 — WhatsApp List messages 🟡
`OutboundList` type + Meta body builder + `list_reply` routing; convert onboarding language/market prompts and the balance quick-action menu to Lists.

### Phase 3 — Voice-note acknowledgment 🟡
"🎤 Got your voice note — one moment…" before transcription; friendlier failure copy.

### Phase 4 — Transaction history + Airtime/Data 🔴
`transaction-history.service.ts`, `airtime.service.ts`, implement `flutterwave-bills.adapter.ts` stubs, new orchestrator intents (`history`, `airtime`, `data`), date-range repo queries.

### Phase 5 — Receipt enrichment + insufficient-funds UX + fee line 🟡
Provider ref / txn id on the receipt; auto-suggest funding on shortfall; fee transparency line (needs Q1).

### Phase 6 — Settings, support tickets, welcome video 🟢
`settings.service.ts`, `support.service.ts` (+ `support_tickets` table), optional welcome video (Q3).

### Phase 7 — Batch transfers (backlog) 🟡
Text + Excel multi-recipient payouts. Not scheduled for the MVP demo.
