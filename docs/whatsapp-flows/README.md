# WhatsApp Flows

Two encrypted data-exchange Flows that move sensitive input out of the chat thread
into native WhatsApp modals. Both share one crypto layer, one endpoint, and one
RSA keypair — they only differ by which Flow definition (and Flow ID) is used.

- `apps/api/src/channel/whatsapp-flow.service.ts` — RSA/AES-GCM crypto + flow tokens
- `apps/api/src/webhooks/whatsapp-flow.controller.ts` — `POST /webhooks/whatsapp/flow`
  (routes by flow-token prefix: `obflow_` → onboarding, otherwise the PIN flow)
- `pin-flow.json` — single-screen **transaction PIN** Flow
- `onboarding-flow.json` — Xara-style **multi-screen onboarding** Flow
  (Welcome → Account Details → Address → Set PIN), driven by
  `apps/api/src/onboarding/onboarding.service.ts` → `handleFlowExchange`

Both Flows degrade gracefully: with `WHATSAPP_PIN_FLOW_ID` unset the app uses the
chat-based PIN; with `WHATSAPP_ONBOARDING_FLOW_ID` unset it uses the chat
onboarding wizard. Nothing breaks before setup is complete.

## The onboarding Flow (Xara parity)

`onboarding-flow.json` is server-navigated: each screen's footer fires
`data_exchange`, and `handleFlowExchange` validates + persists the data and returns
the next screen. The **BVN/NIN is verified mid-flow** — on the Account Details
submit we provision the Flutterwave NUBAN, and a bad ID re-shows that screen with an
inline error instead of failing after the modal closes. The **State picker is a
static `data-source`** in the JSON (36 states + FCT) — no external API. After the
PIN screen the modal closes and the app posts the funding-account card to the chat.

Setup is identical to the PIN flow below — reuse the same keypair, create the Flow
from `onboarding-flow.json`, and set `WHATSAPP_ONBOARDING_FLOW_ID` to its Flow ID.
To send it unprompted (Xara's "Hi 👋 … Complete Onboarding"), also create a **Flow
message template** with a Flow button pointing at this Flow ID; in-session replies
need no template.

## The PIN Flow — secure PIN entry

The encrypted data-exchange Flow that collects the transaction PIN inside a native
WhatsApp modal instead of the chat thread.

## One-time setup

### 1. Generate an RSA-2048 keypair

```bash
# Private key (encrypted with a passphrase you choose)
openssl genrsa -aes256 -passout pass:YOUR_PASSPHRASE -out flow_private.pem 2048
# Public key
openssl rsa -in flow_private.pem -passin pass:YOUR_PASSPHRASE -pubout -out flow_public.pem
```

Put them in your env (`.env`):

```bash
# Collapse the PEM to one line with literal \n — the service expands \n back to newlines.
WHATSAPP_FLOW_PRIVATE_KEY="$(awk 'BEGIN{ORS="\\n"}1' flow_private.pem)"
WHATSAPP_FLOW_KEY_PASSPHRASE=YOUR_PASSPHRASE
```

### 2. Upload the public key to WhatsApp

```bash
curl -X POST "https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/whatsapp_business_encryption" \
  -H "Authorization: Bearer ${META_WHATSAPP_TOKEN}" \
  --data-urlencode "business_public_key=$(cat flow_public.pem)"
```

Verify it registered:

```bash
curl "https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/whatsapp_business_encryption" \
  -H "Authorization: Bearer ${META_WHATSAPP_TOKEN}"
```

### 3. Create the Flow in WhatsApp Manager

1. WhatsApp Manager → **Flows** → **Create Flow** → start blank.
2. In the editor, paste the contents of `pin-flow.json`.
3. **Endpoint URI:** `https://<your-domain>/webhooks/whatsapp/flow`
   (e.g. `https://guildpay.guildserver.io/webhooks/whatsapp/flow`).
4. Save. Meta sends a **health-check ping** to the endpoint — it must return
   `{ "data": { "status": "active" } }` (encrypted). Our controller handles this.
5. **Publish** the Flow, then copy its **Flow ID**.

### 4. Configure the app

```bash
WHATSAPP_PIN_FLOW_ID=<the-flow-id>
WHATSAPP_FLOW_MODE=published        # or `draft` to test before publishing
```

Restart the API. Returning users with a PIN now approve transfers via the modal;
first-time PIN setup still happens in chat (a Flow can't safely both set and verify a PIN).

## Testing before publishing

Set `WHATSAPP_FLOW_MODE=draft` and keep the Flow unpublished — the outbound message
is sent with `mode: "draft"`, so only admins of the WhatsApp account can open it.

## Security notes

- The PIN exists only inside the decrypted endpoint exchange — never in chat, never logged.
- The `flow_token` is HMAC-signed and binds a response to one `pending_otp` transaction.
- Money still moves only through `submitPin` → `pinGate`; the Flow just changes how the PIN arrives.
