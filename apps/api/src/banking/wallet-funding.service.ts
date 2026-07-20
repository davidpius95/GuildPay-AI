import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { WalletRow } from '../database/wallets.repository';
import { TransactionsRepository } from '../database/transactions.repository';
import { UsersRepository } from '../database/users.repository';
import { AuditRepository } from '../database/audit.repository';
import { WalletService } from './wallet.service';
import { formatMoney } from './money';

export interface CreditInboundParams {
  wallet: WalletRow;
  amount: number;
  currency: Currency;
  /** Provider transaction reference — the idempotency key for this credit. */
  providerRef: string;
  /** For the audit trail, e.g. 'bank_transfer'. */
  source: string;
}

/**
 * Credits a wallet for inbound funding (money landing in a user's NUBAN). Shared by
 * the Flutterwave v3 and v4 webhook handlers so the money-movement path — dedupe →
 * funding txn → ledger credit → audit → user notification — lives in exactly one
 * place. Idempotent on `providerRef`: a duplicate webhook delivery is a no-op.
 */
@Injectable()
export class WalletFundingService {
  private readonly logger = new Logger(WalletFundingService.name);

  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly txns: TransactionsRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly wallet: WalletService,
  ) {}

  /** Returns true if a credit was applied, false if it was a duplicate. */
  async creditInbound(params: CreditInboundParams): Promise<boolean> {
    const { wallet, amount, currency, providerRef, source } = params;

    // Idempotency: providers retry and can double-deliver.
    if (await this.txns.findByProviderRef(providerRef)) {
      this.logger.log(`funding duplicate ignored (providerRef=${providerRef})`);
      return false;
    }

    const txn = await this.txns.create({
      walletId: wallet.id,
      type: 'funding',
      channel: 'system', // inbound webhook credit — not a user channel
      currency,
      amount,
      providerRef,
      status: 'completed',
    });
    const balance = await this.wallet.credit(
      wallet.id,
      amount,
      txn.id,
      'Wallet Funding via Flutterwave',
      providerRef,
    );
    await this.audit.record({
      userId: wallet.user_id,
      action: 'wallet_funded',
      entity: 'transaction',
      entityId: txn.id,
      metadata: { amount, source },
    });

    const user = await this.users.findById(wallet.user_id);
    if (user) {
      await this.channel.send({
        to: user.wa_phone,
        kind: 'text',
        body: `💰 Received ${formatMoney(currency, amount)}.\nNew balance: ${formatMoney(currency, balance)}`,
      });
    }
    this.logger.log(`wallet ${wallet.reference} funded ${amount} ${currency} (providerRef=${providerRef})`);
    return true;
  }
}
