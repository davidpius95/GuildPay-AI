import { NextResponse, type NextRequest } from 'next/server';

/**
 * HTTP Basic Auth gate — the dashboard is publicly routed and shows real user/txn
 * data, so it stays behind credentials. Set DASHBOARD_USER + DASHBOARD_PASSWORD.
 * Fail-closed: if they aren't configured, access is denied (never open by accident).
 */
export function middleware(req: NextRequest): NextResponse {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;

  const deny = (msg: string) =>
    new NextResponse(msg, {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="GuildPay Admin", charset="UTF-8"' },
    });

  if (!user || !pass) return deny('Dashboard auth is not configured.');

  const header = req.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = atob(encoded).split(':'); // atob is available on the Edge runtime
    if (u === user && p === pass) return NextResponse.next();
  }
  return deny('Authentication required.');
}

// Guard everything except Next internals and static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
