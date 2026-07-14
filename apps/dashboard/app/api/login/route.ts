import { NextResponse } from 'next/server';

/** Absolute URL on the public host (behind Cloudflare/Traefik) for a safe redirect. */
function urlFor(req: Request, path: string): URL {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'guildpay.guildserver.io';
  return new URL(path, `https://${host}`);
}

export async function POST(req: Request): Promise<NextResponse> {
  const form = await req.formData();
  const password = String(form.get('password') ?? '');
  const expected = process.env.DASHBOARD_PASSWORD;
  const token = process.env.DASHBOARD_SESSION_TOKEN;

  if (!expected || !token || password !== expected) {
    return NextResponse.redirect(urlFor(req, '/login?e=1'), { status: 303 });
  }

  const res = NextResponse.redirect(urlFor(req, '/'), { status: 303 });
  res.cookies.set('gp_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12, // 12h
  });
  return res;
}
