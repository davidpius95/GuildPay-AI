import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlutterwaveV4TokenService } from './flutterwave-v4-token.service';
import type { ConfigService } from '@nestjs/config';

function config(vals: Record<string, string>): ConfigService {
  return { get: (k: string) => vals[k] } as unknown as ConfigService;
}

const CREDS = { FLW_V4_CLIENT_ID: 'id', FLW_V4_CLIENT_SECRET: 'secret' };

function mockToken(access: string, expiresIn = 600) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: access, expires_in: expiresIn }),
  })) as unknown as typeof fetch;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('FlutterwaveV4TokenService', () => {
  it('caches the token and does not refetch while fresh', async () => {
    const f = mockToken('tok-1');
    vi.stubGlobal('fetch', f);
    const svc = new FlutterwaveV4TokenService(config(CREDS));

    expect(await svc.getToken()).toBe('tok-1');
    expect(await svc.getToken()).toBe('tok-1');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refetches once the token is within the refresh skew of expiry', async () => {
    // expires_in below the 60s skew → always considered stale → refetch every call.
    const f = mockToken('tok-x', 30);
    vi.stubGlobal('fetch', f);
    const svc = new FlutterwaveV4TokenService(config(CREDS));

    await svc.getToken();
    await svc.getToken();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent requests into one fetch', async () => {
    const f = mockToken('tok-c');
    vi.stubGlobal('fetch', f);
    const svc = new FlutterwaveV4TokenService(config(CREDS));

    const [a, b] = await Promise.all([svc.getToken(), svc.getToken()]);
    expect(a).toBe('tok-c');
    expect(b).toBe('tok-c');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('throws when credentials are missing', async () => {
    const svc = new FlutterwaveV4TokenService(config({}));
    await expect(svc.getToken()).rejects.toThrow(/CLIENT_ID/);
  });

  it('throws on a non-ok token response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) })),
    );
    const svc = new FlutterwaveV4TokenService(config(CREDS));
    await expect(svc.getToken()).rejects.toThrow(/token request failed/);
  });
});
