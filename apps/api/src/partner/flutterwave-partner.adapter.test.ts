import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlutterwavePartnerAdapter } from './flutterwave-partner.adapter';
import type { ConfigService } from '@nestjs/config';
import type { FlutterwaveV4Client } from './flutterwave-v4.client';

function config(vals: Record<string, string>): ConfigService {
  return { get: (k: string) => vals[k] } as unknown as ConfigService;
}

const V4_ON = {
  FLW_V4_CLIENT_ID: 'id',
  FLW_V4_CLIENT_SECRET: 'secret',
  FLW_VA_BANK_CODE: '035',
};

const REQ = { userRef: 'GPA-NG-ABC', email: 'a@b.co', firstName: 'Ada', lastName: 'Eze', phone: '2348030000000', bvn: '12345678901' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('FlutterwavePartnerAdapter.createVirtualAccount — v3/v4 branch', () => {
  it('uses the v4 client when creds + bank code are set', async () => {
    const v4 = {
      createCustomer: vi.fn(async () => ({ id: 'cus_1' })),
      createVirtualAccount: vi.fn(async () => ({ accountNumber: '9911', bankName: 'WEMA BANK', providerRef: 'va_1' })),
    } as unknown as FlutterwaveV4Client;
    const adapter = new FlutterwavePartnerAdapter(config(V4_ON), v4);

    const res = await adapter.createVirtualAccount(REQ);

    expect(res).toEqual({ accountNumber: '9911', bankName: 'WEMA BANK', providerRef: 'va_1' });
    expect(v4.createCustomer).toHaveBeenCalledOnce();
    expect(v4.createVirtualAccount).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'GPA-NG-ABC', customerId: 'cus_1', bankCode: '035', bvn: '12345678901' }),
    );
  });

  it('propagates a v4 error (preserving the onboarding BVN gate)', async () => {
    const v4 = {
      createCustomer: vi.fn(async () => ({ id: 'cus_1' })),
      createVirtualAccount: vi.fn(async () => {
        throw new Error('bvn mismatch');
      }),
    } as unknown as FlutterwaveV4Client;
    const adapter = new FlutterwavePartnerAdapter(config(V4_ON), v4);
    await expect(adapter.createVirtualAccount(REQ)).rejects.toThrow(/bvn mismatch/);
  });

  it('falls back to v3 when the v4 flag is off', async () => {
    const v4 = { createCustomer: vi.fn(), createVirtualAccount: vi.fn() } as unknown as FlutterwaveV4Client;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', data: { account_number: '0088', bank_name: 'Indulge MFB', order_ref: 'ord_1' } }),
      })),
    );
    const adapter = new FlutterwavePartnerAdapter(config({ FLW_SECRET_KEY: 'k' }), v4);

    const res = await adapter.createVirtualAccount(REQ);
    expect(res).toEqual({ accountNumber: '0088', bankName: 'Indulge MFB', providerRef: 'ord_1' });
    expect(v4.createVirtualAccount).not.toHaveBeenCalled();
  });
});

describe('FlutterwavePartnerAdapter.verifyIdentity — BVN consent', () => {
  const v4 = {} as unknown as FlutterwaveV4Client;
  const cfg = { FLW_SECRET_KEY: 'k', FLW_BVN_REDIRECT_URL: 'https://guildpay/kyc/callback' };

  it('starts the consent flow and returns pending + consent URL (from data.url)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: { reference: 'ref_1', url: 'https://flw/consent/1' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FlutterwavePartnerAdapter(config(cfg), v4);

    const res = await adapter.verifyIdentity({ type: 'bvn', idNumber: '12345678901', firstName: 'Ada' });

    expect(res).toEqual({
      type: 'bvn',
      status: 'pending',
      reference: 'ref_1',
      consentUrl: 'https://flw/consent/1',
      message: 'Awaiting BVN consent',
    });
    // Redirect URL is passed through to Flutterwave.
    const init = (fetchMock.mock.calls[0] as any[])[1] as { body: string };
    expect(JSON.parse(init.body).redirect_url).toBe('https://guildpay/kyc/callback');
  });

  it('reads the consent URL from meta.authorization.redirect when data.url is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: { reference: 'ref_2' },
          meta: { authorization: { mode: 'redirect', redirect: 'https://flw/consent/2' } },
        }),
      })),
    );
    const adapter = new FlutterwavePartnerAdapter(config(cfg), v4);
    const res = await adapter.verifyIdentity({ type: 'bvn', idNumber: '12345678901' });
    expect(res.status).toBe('pending');
    expect(res.consentUrl).toBe('https://flw/consent/2');
    expect(res.reference).toBe('ref_2');
  });

  it('throws when no consent redirect URL is configured', async () => {
    const adapter = new FlutterwavePartnerAdapter(config({ FLW_SECRET_KEY: 'k' }), v4);
    await expect(adapter.verifyIdentity({ type: 'bvn', idNumber: '12345678901' })).rejects.toThrow(
      /FLW_BVN_REDIRECT_URL/,
    );
  });

  it('fetchBvnVerification re-reads authoritative status + name at source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: { reference: 'ref_1', status: 'COMPLETED', bvn_data: { first_name: 'Ada', last_name: 'Eze' } },
        }),
      })),
    );
    const adapter = new FlutterwavePartnerAdapter(config(cfg), v4);
    const res = await adapter.fetchBvnVerification('ref_1');
    expect(res).toEqual({ type: 'bvn', status: 'verified', reference: 'ref_1', name: 'Ada Eze' });
  });
});
