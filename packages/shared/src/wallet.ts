import { z } from 'zod';
import { CurrencySchema } from './currency';

export const MarketSchema = z.enum(['NG', 'QA']);
export type Market = z.infer<typeof MarketSchema>;

export const AccountStatusSchema = z.enum(['pending', 'active', 'frozen', 'closed']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/** A user's wallet. Balance is denormalized; the ledger is source of truth. */
export const WalletSchema = z.object({
  reference: z.string().min(1), // GuildPay ref e.g. GPA-NG-000123
  currency: CurrencySchema,
  market: MarketSchema,
  balance: z.number().nonnegative(),
  status: AccountStatusSchema,
  // NGN: the dedicated NUBAN the user funds into (from Flutterwave). Null for QAR.
  virtualAccountNumber: z.string().min(1).nullable(),
  virtualBankName: z.string().min(1).nullable(),
});
export type Wallet = z.infer<typeof WalletSchema>;

/** A saved recipient (GuildPay user or external bank account). */
export const BeneficiarySchema = z.object({
  alias: z.string().min(1).nullable(),
  name: z.string().min(1), // verified via name enquiry for bank beneficiaries
  ref: z.string().min(1), // account number or GuildPay ref
  bankCode: z.string().min(1).nullable(),
  currency: CurrencySchema,
});
export type Beneficiary = z.infer<typeof BeneficiarySchema>;

/** Result of a bank name-enquiry — shown in the confirmation card before payout. */
export const NameEnquiryResultSchema = z.object({
  accountNumber: z.string().min(1),
  bankCode: z.string().min(1),
  accountName: z.string().min(1),
});
export type NameEnquiryResult = z.infer<typeof NameEnquiryResultSchema>;
