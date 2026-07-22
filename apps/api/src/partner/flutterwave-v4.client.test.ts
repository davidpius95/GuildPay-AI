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
        json: async () => ({ data: { account_number: '9911223344', account_bank_name: 'WEMA BANK', id: 'va_1' } }),
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

  it('falls back to the known bank name when the response omits it', async () => {
    const { client } = make(
      vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ data: { account_number: '9911', id: 'va_2' } }) })) as unknown as typeof fetch,
    );
    const res = await client.createVirtualAccount({ reference: 'r', customerId: 'c', bankCode: '035' });
    expect(res.bankName).toBe('WEMA BANK');
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

  it('recovers from a 409 by reusing the existing customer id from the response body', async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ status: 'error', message: 'Customer already exists', data: { id: 'cus_existing' } }),
    })) as unknown as typeof fetch;
    const { client } = make(f);
    // 409 on create → no throw; existing id recovered from the body (no lookup needed).
    expect(await client.createCustomer({ email: 'a@b.co' }, 'cust:a@b.co')).toEqual({ id: 'cus_existing' });
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('recovers from a 409 with no id by looking the customer up by email', async () => {
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ status: 'error', message: 'Customer already exists' }) };
      }
      // GET /customers?email=... → return the matching customer.
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'cus_looked_up', email: 'a@b.co' }] }) };
    }) as unknown as typeof fetch;
    const { client } = make(f);
    expect(await client.createCustomer({ email: 'a@b.co' }, 'cust:a@b.co')).toEqual({ id: 'cus_looked_up' });
  });
});
