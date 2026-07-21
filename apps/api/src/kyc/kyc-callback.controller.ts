import { Controller, Get, Header } from '@nestjs/common';

/**
 * Public landing page Flutterwave redirects the user to after they finish the BVN
 * consent flow (FLW_BVN_REDIRECT_URL points here). It is purely informational:
 * the wallet/NUBAN is provisioned by the `bvn.verification.completed` webhook, and
 * the user gets the real outcome back in WhatsApp — so this page stays neutral
 * rather than claiming success/failure. No auth, no secrets, no DB access.
 */
@Controller('kyc')
export class KycCallbackController {
  @Get('bvn-callback')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  bvnCallback(): string {
    return PAGE;
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>GuildPay — BVN Verification</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b7a4b; color: #0f172a;
  }
  .card {
    width: 100%; max-width: 420px; background: #ffffff; border-radius: 18px;
    padding: 32px 28px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,.25);
  }
  .badge {
    width: 64px; height: 64px; margin: 0 auto 20px; border-radius: 50%;
    background: #e7f7ef; display: flex; align-items: center; justify-content: center; font-size: 32px;
  }
  h1 { margin: 0 0 10px; font-size: 20px; }
  p { margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #475569; }
  .hint { font-size: 13px; color: #94a3b8; }
  .brand { margin-top: 22px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #0b7a4b; font-weight: 700; }
  @media (prefers-color-scheme: dark) {
    body { background: #06301f; }
    .card { background: #0f172a; color: #e2e8f0; box-shadow: 0 20px 50px rgba(0,0,0,.5); }
    p { color: #94a3b8; }
    .badge { background: #0e3a27; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="badge">✅</div>
    <h1>Verification received</h1>
    <p>Thanks! We've received your BVN confirmation. You can close this tab now.</p>
    <p class="hint">Head back to <strong>WhatsApp</strong> — GuildPay will finish setting up your wallet and message you in a moment.</p>
    <div class="brand">GuildPay</div>
  </main>
</body>
</html>`;
