import { describe, expect, it, vi } from 'vitest';
import { SnapToPayService } from './snap-to-pay.service';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UserRow } from '../database/users.repository';
import type { WalletRow } from '../database/wallets.repository';
import type { AiService } from '../ai/ai.service';
import type { BankTransferService } from './bank-transfer.service';

const user = { id: 'u1', wa_phone: '2348000000001', full_name: 'Ada' } as unknown as UserRow;
const wallet = { id: 'w1', currency: 'NGN' } as unknown as WalletRow;

function make(visionReply: string) {
  const send = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined);
  const extractFromImage = vi.fn(async () => visionReply);
  const svc = new SnapToPayService(
    { send } as unknown as ChannelAdapter,
    { extractFromImage } as unknown as AiService,
    { start } as unknown as BankTransferService,
  );
  return { svc, send, start, extractFromImage };
}

const img = Buffer.from('fake');

describe('SnapToPayService', () => {
  it('fully-read image → hands to the OTP-gated bank transfer (never sends directly)', async () => {
    const h = make('{"accountNumber":"0690000031","bankName":"Access Bank","amount":5000}');
    await h.svc.fromImage(user, wallet, img, 'image/jpeg');
    expect(h.start).toHaveBeenCalledWith(user, wallet, 5000, '0690000031', 'Access Bank');
  });

  it('partial read (no amount) → echoes details and asks, no transfer started', async () => {
    const h = make('{"accountNumber":"0690000031","bankName":"Access Bank","amount":null}');
    await h.svc.fromImage(user, wallet, img, 'image/jpeg');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('0690000031') }),
    );
  });

  it('unreadable image → guidance, no transfer', async () => {
    const h = make('sorry, no details visible');
    await h.svc.fromImage(user, wallet, img, 'image/jpeg');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('rejects a non-10-digit account (never guesses)', async () => {
    const h = make('{"accountNumber":"123","bankName":"Access Bank","amount":5000}');
    await h.svc.fromImage(user, wallet, img, 'image/jpeg');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('non-NGN wallet is rejected', async () => {
    const h = make('{"accountNumber":"0690000031","bankName":"X","amount":5000}');
    await h.svc.fromImage(user, { id: 'w2', currency: 'QAR' } as unknown as WalletRow, img, 'image/jpeg');
    expect(h.start).not.toHaveBeenCalled();
  });
});
