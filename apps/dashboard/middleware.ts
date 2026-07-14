import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cookie-based auth gate. The dashboard is publicly routed and shows real user/txn
 * data, so it stays behind a login. We avoid HTTP Basic Auth on purpose — its 401
 * challenge loops in Chrome over HTTP/2 behind Cloudflare (ERR_TOO_MANY_RETRIES).
 *
 * Flow: no valid session cookie → redirect to /login (always allowed, so no loop).
 * The /login form posts to /api/login, which sets the cookie on a correct password.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Always allow the login page + its API + static assets → prevents redirect loops.
  if (pathname.startsWith('/login') || pathname.startsWith('/api/login')) {
    return NextResponse.next();
  }

  const token = process.env.DASHBOARD_SESSION_TOKEN;
  const cookie = req.cookies.get('gp_session')?.value;
  if (token && cookie && cookie === token) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
