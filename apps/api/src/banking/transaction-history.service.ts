import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Currency } from '@guildpay/shared';
import { PG_POOL } from '../database/database.constants';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UserRow } from '../database/users.repository';
import type { WalletRow } from '../database/wallets.repository';
import { formatMoney } from './money';

/** One line of wallet history: a ledger entry plus context from its transaction. */
export interface HistoryLine {
  direction: 'debit' | 'credit';
  amount: string;
  balance_after: string;
  created_at: string;
  type: string | null;
  recipient_name: string | null;
  status: string | null;
}

const HISTORY_LIMIT = 10;

/**
 * Transaction history (read-only) — reads the append-only ledger (source of truth
 * for money movement, so it shows both credits and debits) joined with the
 * originating transaction for names/context, and formats a WhatsApp-friendly list.
 */
@Injectable()
export class TransactionHistoryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
  ) {}

  async send(user: UserRow, wallet: WalletRow): Promise<void> {
    const lines = await this.recent(wallet.id, HISTORY_LIMIT);
    await this.channel.send({
      to: user.wa_phone,
      kind: 'text',
      body: formatHistory(lines, wallet.currency as Currency),
    });
  }

  private async recent(walletId: string, limit: number): Promise<HistoryLine[]> {
    const { rows } = await this.pool.query<HistoryLine>(
      `select le.direction, le.amount, le.balance_after, le.created_at,
              t.type, t.recipient_name, t.status
       from public.ledger_entries le
       left join public.transactions t on t.id = le.transaction_id
       where le.wallet_id = $1
       order by le.created_at desc
       limit $2`,
      [walletId, limit],
    );
    return rows;
  }
}

/** Render ledger lines as a WhatsApp history card (pure — unit-tested). */
export function formatHistory(lines: HistoryLine[], currency: Currency): string {
  if (lines.length === 0) {
    return '📜 *Your transactions*\n\nNo transactions yet. Fund your wallet or send money to get started.';
  }
  const rows = lines.map((l) => {
    const credit = l.direction === 'credit';
    const icon = credit ? '⬇️' : '⬆️';
    const money = formatMoney(currency, l.amount);
    const who = counterparty(l, credit);
    return `${icon} *${money}* ${credit ? 'from' : 'to'} ${who}\n   ${formatWhen(l.created_at)}`;
  });
  const latestBalance = formatMoney(currency, lines[0]!.balance_after);
  return `📜 *Your transactions*\n\n${rows.join('\n\n')}\n\nBalance: *${latestBalance}*`;
}

function counterparty(l: HistoryLine, credit: boolean): string {
  if (l.recipient_name) return l.recipient_name;
  if (l.type === 'fund' || (credit && !l.type)) return 'Wallet funding';
  return credit ? 'a sender' : 'a recipient';
}

/** e.g. "Jul 2, 2026, 2:01 PM" — locale-stable, no external deps. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
