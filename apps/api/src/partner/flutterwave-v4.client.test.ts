import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlutterwaveV4Client } from './flutterwave-v4.client';
import type { ConfigService } from '@nestjs/config';
import type { FlutterwaveV4TokenService } from './flutterwave-v4-token.service';

function make(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  const config = { get: (k: string) => ({ FLW_V4_BASE_URL: 'https://v4.test' } as Record<string, string>)[k] } as unknown as ConfigService;
  const tokens = { getToken: vi.fn(async () => 'bearer-xyz') } as unknown as FlutterwaveV4TokenService;
  return { client: new FlutterwaveV4Client(config, tokens), tokens };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('FlutterwaveV4Client', () => {
  it('creates a virtual account and maps to the {accountNumber,bankName,providerRef} contract', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      sent = { url, init };
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { account_number: '9911223344', bank_name: 'WEMA BANK', id: 'va_1' } }),
      };
    }) as unknown as typeof fetch;
    const { client } = make(f);

    const res = await client.createVirtualAccount({
      reference: 'GPA-NG-ABC',
      customerId: 'cus_1',
      bvn: '12345678901',
      bankCode: '035',
    });

    expect(res).toEqual({ accountNumber: '9911223344', bankName: 'WEMA BANK', providerRef: 'va_1' });
    // Sends bank_code + static account type + idempotency + bearer.
    const body = JSON.parse((sent!.init.body as string));
    expect(body).toMatchObject({ bank_code: '035', account_type: 'static', currency: 'NGN', amount: 0, customer_id: 'cus_1' });
    const headers = sent!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer bearer-xyz');
    expect(headers['X-Idempotency-Key']).toBe('GPA-NG-ABC');
    expect(sent!.url).toBe('https://v4.test/virtual-accounts');
  });

  it('creates a customer with structured name/phone objects (v4 rejects flat strings)', async () => {
    let sent: { init: RequestInit } | null = null;
    const { client } = make(
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = { init };
        return { ok: true, status: 201, json: async () => ({ data: { id: 'cus_9' } }) };
      }) as unknown as typeof fetch,
    );

    const res = await client.createCustomer(
      { email: 'a@b.co', firstName: 'Ada', lastName: 'Eze', phone: '2348030000000' },
      'cust:ref',
    );

    expect(res).toEqual({ id: 'cus_9' });
    const body = JSON.parse(sent!.init.body as string);
    expect(body).toEqual({
      email: 'a@b.co',
      name: { first: 'Ada', last: 'Eze' },
      phone: { country_code: '234', number: '8030000000' },
    });
  });

  it('omits name/phone when not provided', async () => {
    let sent: { init: RequestInit } | null = null;
    const { client } = make(
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = { init };
        return { ok: true, status: 201, json: async () => ({ id: 'cus_flat' }) };
      }) as unknown as typeof fetch,
    );
    expect(await client.createCustomer({ email: 'a@b.co' }, 'cust:ref')).toEqual({ id: 'cus_flat' });
    expect(JSON.parse(sent!.init.body as string)).toEqual({ email: 'a@b.co' });
  });

  it('throws on a non-2xx without leaking the request body', async () => {
    const { client } = make(
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ message: 'bad bvn' }) })) as unknown as typeof fetch,
    );
    await expect(
      client.createVirtualAccount({ reference: 'r', customerId: 'c', bankCode: '035' }),
    ).rejects.toThrow(/bad bvn/);
  });
});
