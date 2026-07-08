# GuildPay AI — Accounts, APIs, Webhooks & Deployment Guide

> Everything you need to sign up for, every environment variable, every webhook, and how to
> deploy to **guildpay.guildserver.io** on your own Guild Server box (Docker + Traefik +
> Cloudflare Tunnel). Optimised for **free / free-tier** services.

---

## 0. TL;DR — what this costs

| Service | Purpose | Free? | Notes |
|---|---|---|---|
| **Your Guild Server** | Hosting (api + dashboard + db + redis) | ✅ Free | You already own it. Docker + Traefik + tunnel already running. |
| **Cloudflare Tunnel + DNS** | Public HTTPS for `guildpay.guildserver.io` | ✅ Free | Wildcard route already exists — subdomain already resolves. |
| **Meta WhatsApp Cloud API** | Send/receive WhatsApp | ✅ Free tier | 1,000 service conversations/mo free. Test number is free. |
| **Twilio WhatsApp Sandbox** | Fallback channel | ✅ Free | Instant sandbox; only if Meta verification stalls. |
| **PostgreSQL** (self-hosted container) | System of record + ledger | ✅ Free | Runs on your box. (Or reuse your self-hosted Supabase.) |
| **Redis** (self-hosted container) | Sessions, OTP TTLs, rate limits | ✅ Free | Runs on your box. (Or Upstash free tier.) |
| **Flutterwave** | NGN rail (Naira) | ✅ Free (sandbox) | Test keys only. No live payouts in MVP. |
| **Anthropic Claude API** | Intent + vision extraction + support | 💲 **Paid (usage)** | ~$30–80 across the whole demo. The one unavoidable spend. New orgs may get trial credit. |
| **Speech-to-text** | Voice notes → text | 💲 or ✅ | OpenAI Whisper ≈ $5–15 (simplest), **or** self-host `faster-whisper` on your box = free. |
| **Sentry** | Error tracking (optional) | ✅ Free tier | Optional for demo. |

**Bottom line:** the only thing you truly pay for is **Claude API usage** (small). Whisper can be
free if you self-host it. Everything else is free tier or on your own server.

---

## 1. Accounts to create (in priority order)

Do these in order — item 1 has the longest lead time.

### 1.1 Meta WhatsApp Cloud API  ⏳ *start first (verification takes 1–5 days)*
1. Create a **Meta Business account**: https://business.facebook.com
2. Go to **Meta for Developers**: https://developers.facebook.com → **My Apps → Create App → "Business"**.
3. Add the **WhatsApp** product. Meta issues a **free test phone number** immediately.
4. From **WhatsApp → API Setup**, copy:
   - **Temporary access token** (24h) — for first tests. Then create a **System User** with a
     **permanent token** (Business Settings → Users → System Users → generate token with
     `whatsapp_business_messaging` + `whatsapp_business_management`).
   - **Phone number ID** and **WhatsApp Business Account (WABA) ID**.
5. From **App → Settings → Basic**, copy the **App Secret** (used to verify webhook signatures).
6. Start **Business Verification** now (Business Settings → Security Center). It gates production
   messaging; the test number works without it for the demo.

→ Fills: `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_APP_SECRET`,
`META_WEBHOOK_VERIFY_TOKEN` (you invent this string — see §3).

### 1.2 Twilio (fallback, optional but recommended)
1. Sign up: https://www.twilio.com/try-twilio (free trial).
2. **Messaging → Try it out → WhatsApp Sandbox**. Join the sandbox from your phone (send the join code).
3. Copy **Account SID**, **Auth Token**, and the sandbox **From** number (`whatsapp:+14155238886`).

→ Fills: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`.

### 1.3 Anthropic (Claude) — *required, paid usage*
1. Sign up: https://console.anthropic.com
2. **Settings → API Keys → Create Key**. Add a small amount of credit (Billing).
3. Model for MVP: `claude-sonnet-4-6` (intent + vision). Keep an eye on usage in the console.

→ Fills: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.

### 1.4 Speech-to-text — pick ONE
- **Option A (simplest, paid):** OpenAI Whisper API. Sign up https://platform.openai.com → API Keys.
  → Fills: `OPENAI_API_KEY`.
- **Option B (free, self-hosted):** run `faster-whisper` in a container on your box (you have 4 cores
  / 15 GB RAM — fine for demo volume). Point the STT service at `http://guildpay-whisper:9000`.
  → Fills: `STT_PROVIDER=local`, `STT_LOCAL_URL`. (No OpenAI key needed.)

### 1.5 Flutterwave (NGN rail) — *sandbox, free*
1. Sign up: https://dashboard.flutterwave.com
2. Toggle to **Test/Sandbox** mode. **Settings → API Keys** → copy the **TEST** keys
   (`FLWPUBK_TEST-…`, `FLWSECK_TEST-…`) and **Encryption Key**.
3. **Settings → Webhooks** → set the URL (see §4) and a **Secret hash** — you choose this string; it
   comes back in the `verif-hash` header so you can verify webhooks.

→ Fills: `FLW_PUBLIC_KEY`, `FLW_SECRET_KEY`, `FLW_ENCRYPTION_KEY`, `FLW_WEBHOOK_SECRET_HASH`, `FLW_BASE_URL`.

### 1.6 Database & cache — *self-hosted on your box (free)*
No signup. The production compose file runs a dedicated `guildpay-postgres` and `guildpay-redis`
container. (Alternative: reuse your existing self-hosted Supabase stack for storage/auth — see §6.4.)

→ Fills: `DATABASE_URL`, `REDIS_URL`.

### 1.7 Sentry (optional)
Sign up https://sentry.io (free tier) → create a Node project → copy the DSN. → `SENTRY_DSN`.

---

## 2. Domain: guildpay.guildserver.io

**Good news — it already works.** Your Cloudflare Tunnel (`/etc/cloudflared/config.yml`) already has:

```yaml
ingress:
  - hostname: guildserver.io          → http://localhost:80
  - hostname: www.guildserver.io      → http://localhost:80
  - hostname: "*.guildserver.io"      → http://localhost:80   # ← covers guildpay.guildserver.io
  - service: http_status:404
```

And `dig guildpay.guildserver.io` already returns Cloudflare IPs, so DNS is in place (wildcard).
Traffic to `https://guildpay.guildserver.io` → Cloudflare edge (TLS terminated here) → tunnel →
`localhost:80` → **Traefik** → routed by `Host` header to the right container.

**So you do NOT need to touch cloudflared or DNS.** You only add a container with Traefik labels for
`Host(\`guildpay.guildserver.io\`)`. That's done for you in `docker-compose.prod.yml` (§6).

*If you ever want an explicit (non-wildcard) DNS record instead:*
```bash
cloudflared tunnel route dns 1c20b73e-b364-41a2-915b-e3b91e9927c8 guildpay.guildserver.io
```

---

## 3. Complete environment variable reference

Copy `.env.production.example` → `.env` on the server and fill these in. **Never commit `.env`.**

| Variable | Required | Where it comes from |
|---|---|---|
| `NODE_ENV` | ✅ | `production` |
| `API_PORT` | ✅ | `3001` (internal) |
| `DASHBOARD_PORT` | ✅ | `3000` (internal) |
| `PUBLIC_BASE_URL` | ✅ | `https://guildpay.guildserver.io` |
| `LOG_LEVEL` | – | `info` |
| `CHANNEL_ADAPTER` | ✅ | `meta` or `twilio` |
| `META_WHATSAPP_TOKEN` | ✅ (meta) | Meta → WhatsApp → API Setup (system-user token) |
| `META_PHONE_NUMBER_ID` | ✅ (meta) | Meta → WhatsApp → API Setup |
| `META_WABA_ID` | ✅ (meta) | Meta → WhatsApp → API Setup |
| `META_APP_SECRET` | ✅ (meta) | Meta → App → Settings → Basic |
| `META_WEBHOOK_VERIFY_TOKEN` | ✅ (meta) | **You invent it** — any random string; paste the same value into Meta's webhook config |
| `TWILIO_ACCOUNT_SID` | ✅ (twilio) | Twilio console |
| `TWILIO_AUTH_TOKEN` | ✅ (twilio) | Twilio console |
| `TWILIO_WHATSAPP_FROM` | ✅ (twilio) | Twilio sandbox number, e.g. `whatsapp:+14155238886` |
| `ANTHROPIC_API_KEY` | ✅ | console.anthropic.com |
| `ANTHROPIC_MODEL` | ✅ | `claude-sonnet-4-6` |
| `STT_PROVIDER` | ✅ | `openai` or `local` |
| `OPENAI_API_KEY` | ✅ if `STT_PROVIDER=openai` | platform.openai.com |
| `STT_LOCAL_URL` | ✅ if `STT_PROVIDER=local` | `http://guildpay-whisper:9000` |
| `DATABASE_URL` | ✅ | `postgresql://guildpay:<pw>@guildpay-postgres:5432/guildpay` |
| `REDIS_URL` | ✅ | `redis://guildpay-redis:6379` |
| `FLW_PUBLIC_KEY` | ✅ (NGN) | Flutterwave test keys |
| `FLW_SECRET_KEY` | ✅ (NGN) | Flutterwave test keys |
| `FLW_ENCRYPTION_KEY` | ✅ (NGN) | Flutterwave test keys |
| `FLW_WEBHOOK_SECRET_HASH` | ✅ (NGN) | **You invent it**; paste same value into Flutterwave webhook settings |
| `FLW_BASE_URL` | ✅ (NGN) | `https://api.flutterwave.com/v3` |
| `MEDIA_STORAGE` | ✅ | `local` (volume) or `supabase` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | if `MEDIA_STORAGE=supabase` | your self-hosted Supabase |
| `SENTRY_DSN` | – | sentry.io (optional) |

**Secrets you invent yourself** (not issued by a provider): `META_WEBHOOK_VERIFY_TOKEN`,
`FLW_WEBHOOK_SECRET_HASH`, the Postgres password, and the dashboard admin credentials. Generate them:
```bash
openssl rand -hex 24
```

---

## 4. Webhooks reference

All webhooks are public HTTPS URLs under your domain (TLS handled by Cloudflare):

| Webhook | URL | Verification |
|---|---|---|
| **WhatsApp (Meta)** | `https://guildpay.guildserver.io/webhooks/whatsapp` | GET verify challenge with `META_WEBHOOK_VERIFY_TOKEN`; POST bodies signed with `X-Hub-Signature-256` (HMAC-SHA256 of raw body using `META_APP_SECRET`). |
| **WhatsApp (Twilio)** | `https://guildpay.guildserver.io/webhooks/twilio` | Validate `X-Twilio-Signature`. |
| **Flutterwave** | `https://guildpay.guildserver.io/webhooks/flutterwave` | Compare `verif-hash` header to `FLW_WEBHOOK_SECRET_HASH`. |

**Meta webhook setup:** Meta → App → WhatsApp → Configuration → Edit:
- **Callback URL:** `https://guildpay.guildserver.io/webhooks/whatsapp`
- **Verify token:** the exact string you set in `META_WEBHOOK_VERIFY_TOKEN`
- **Subscribe** to the `messages` field.

**Flutterwave webhook setup:** Dashboard → Settings → Webhooks:
- **URL:** `https://guildpay.guildserver.io/webhooks/flutterwave`
- **Secret hash:** the exact string you set in `FLW_WEBHOOK_SECRET_HASH`.

> These endpoints are implemented in Week 1 (WhatsApp) and the Week 2.5 NGN rail (Flutterwave).
> Until then the routes 404 — that's expected.

---

## 5. Server inventory (what's already on your box)

Detected on `usher-node@143.105.102.121` (read-only check):

- **OS:** Ubuntu 24.04, 4 vCPU, 15 GB RAM, 1.8 TB disk (4% used) — plenty of headroom.
- **Docker** 27.5 (your user is in the `docker` group; **passwordless sudo**).
- **Node** 20.20, **pnpm** 10.34, **git** 2.43.
- **Traefik v3.6** (`guildserver-traefik`) is the ingress on ports 80/443/8080, docker provider,
  network `guildserver`, `exposedbydefault=false`, Let's Encrypt resolver `letsencrypt`.
- **Cloudflared** systemd service, tunnel `1c20b73e-…`, wildcard `*.guildserver.io → localhost:80`.
- A self-hosted **Supabase BaaS platform** already running (multiple stacks) — reusable for storage.
- No Postgres/Redis client on the host, but Postgres runs in containers. We add **dedicated**
  `guildpay-postgres` + `guildpay-redis` containers so GuildPay is isolated from the BaaS stacks.

**Implication:** GuildPay slots in as another Traefik-routed app on the `guildserver` network. No
changes to cloudflared, DNS, or Traefik itself — the app containers carry their own routing labels.

---

## 6. Deploying to the server

### 6.1 One-time: clone the repo on the server
```bash
ssh -p 5555 usher-node@143.105.102.121
mkdir -p ~/apps && cd ~/apps
git clone <your-repo-url> guildpay && cd guildpay   # or rsync your local checkout up
cp .env.production.example .env
nano .env                                           # paste in the keys from §1–§3
```

### 6.2 Bring it up
```bash
cd ~/apps/guildpay
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f guildpay-api
```

### 6.3 Verify
```bash
# from your laptop:
curl https://guildpay.guildserver.io/health          # -> {"status":"ok",...}
```
Then set the Meta and Flutterwave webhook URLs (§4) and send a WhatsApp message to your test number.

### 6.4 (Optional) Use your existing self-hosted Supabase for media storage
You already run Supabase on the box. To store voice/image/xlsx there instead of a local volume, set
`MEDIA_STORAGE=supabase` and point `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` at your stack, and
create a `guildpay-media` storage bucket. For the MVP, `MEDIA_STORAGE=local` (a Docker volume) is the
simplest and is the default.

### 6.5 How routing works (already wired in the compose labels)
- `guildpay.guildserver.io/` → **dashboard** container (Next.js, port 3000)
- `guildpay.guildserver.io/webhooks/*`, `/v1/*`, `/health` → **api** container (NestJS, port 3001)

Both containers join the external `guildserver` network so Traefik discovers them. Postgres and Redis
stay on a private `guildpay-internal` network (not exposed publicly).

---

## 7. Security follow-ups (do these)

1. **Rotate the SSH password** you shared in chat (`usher`) — it's now in a transcript.
   ```bash
   passwd    # on the server, set a strong new password
   ```
2. **Switch to SSH keys** and disable password auth:
   ```bash
   # on your laptop:
   ssh-copy-id -p 5555 usher-node@143.105.102.121
   # then on the server, in /etc/ssh/sshd_config: PasswordAuthentication no ; sudo systemctl restart ssh
   ```
3. **Keep `.env` out of git** (it already is via `.gitignore`). Back it up somewhere private.
4. **Restrict the dashboard** behind auth before the demo (Supabase auth or a Traefik basic-auth
   middleware) — it exposes users/transactions.
5. **Never log** PINs, OTPs, or full QID numbers (already enforced by the pino redaction config).
6. Consider a **Cloudflare Access** policy on the dashboard path for defence in depth.

---

## 8. Quick-start checklist

- [ ] Meta app + test number + permanent token + app secret  → `.env`
- [ ] Anthropic key + credit  → `.env`
- [ ] STT: OpenAI key **or** self-hosted whisper  → `.env`
- [ ] Flutterwave test keys + webhook secret hash  → `.env`
- [ ] Invent `META_WEBHOOK_VERIFY_TOKEN`, `FLW_WEBHOOK_SECRET_HASH`, Postgres password  → `.env`
- [ ] `docker compose -f docker-compose.prod.yml up -d --build` on the server
- [ ] `curl https://guildpay.guildserver.io/health` returns ok
- [ ] Set Meta webhook URL + verify token; subscribe to `messages`
- [ ] Set Flutterwave webhook URL + secret hash
- [ ] Rotate SSH password + move to keys
```
