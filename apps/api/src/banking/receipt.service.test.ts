import { describe, expect, it } from 'vitest';
import { ReceiptService, type ReceiptData } from './receipt.service';

const base: ReceiptData = {
  status: 'COMPLETED',
  currency: 'NGN',
  amount: 150,
  sender: 'DAVID UZOCHUKWU',
  recipient: 'DAVID UZOCHUKWU',
  bank: 'Access Bank',
  account: '1229613501',
  reference: 'ABCD1234',
};

const isPng = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe('ReceiptService.render', () => {
  const svc = new ReceiptService();

  it('renders a PNG for a basic transfer receipt', () => {
    const png = svc.render(base);
    expect(isPng(png)).toBe(true);
  });

  it('renders with the full Flutterwave reference, ID, and fee note (Xara parity)', () => {
    const png = svc.render({
      ...base,
      providerRef: 'TRF927769939037580653864',
      providerId: '1000332607021301200201673',
      feeNote: 'Fee covered by your 30 free transfers/month',
    });
    // Long refs/ids and the extra ID row grow the image but must still render.
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(svc.render(base).length - 1); // ID row adds height
  });

  it('renders a PROCESSING receipt', () => {
    expect(isPng(svc.render({ ...base, status: 'PROCESSING' }))).toBe(true);
  });
});
