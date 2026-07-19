import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getTransactionDetail,
  getLedgerForTransaction,
  getAuditForEntity,
} from '../../../lib/queries';
import { money, timeAgo, titleize } from '../../../lib/format';

export const dynamic = 'force-dynamic';

export default async function TransactionDetail({ params }: { params: { id: string } }) {
  const txn = await getTransactionDetail(params.id);
  if (!txn) notFound();

  const [ledger, audit] = await Promise.all([
    getLedgerForTransaction(params.id),
    getAuditForEntity(params.id, 20),
  ]);

  return (
    <main className="wrap">
      <p className="crumb">
        <Link href="/transactions">← Transactions</Link>
      </p>
      <div className="detail-head">
        <div>
          <h1 className="page">
            {titleize(txn.type)} · {money(txn.currency, txn.amount)}
          </h1>
          <p className="sub mono">{txn.id}</p>
        </div>
        <span className={`badge ${txn.status}`}>{titleize(txn.status)}</span>
      </div>

      <section className="grid2">
        <div className="card">
          <h2>Details</h2>
          <dl className="kv">
            <dt>Amount</dt>
            <dd className="mono">{money(txn.currency, txn.amount)}</dd>
            <dt>Fee</dt>
            <dd className="mono">{money(txn.currency, txn.fee)}</dd>
            <dt>Channel</dt>
            <dd>{txn.channel}</dd>
            <dt>Recipient</dt>
            <dd>{txn.recipient_name ?? '—'}</dd>
            <dt>Recipient ref</dt>
            <dd className="mono">{txn.recipient_ref ?? '—'}</dd>
            <dt>Bank code</dt>
            <dd className="mono">{txn.bank_code ?? '—'}</dd>
            <dt>Purpose</dt>
            <dd>{txn.purpose ?? '—'}</dd>
            <dt>Created</dt>
            <dd>{timeAgo(txn.created_at)}</dd>
            <dt>Confirmed</dt>
            <dd>{txn.confirmed_at ? timeAgo(txn.confirmed_at) : '—'}</dd>
          </dl>
        </div>

        <div className="card">
          <h2>Provider &amp; wallet</h2>
          <dl className="kv">
            <dt>Provider ref</dt>
            <dd className="mono">{txn.provider_ref ?? '—'}</dd>
            <dt>Wallet</dt>
            <dd className="mono">{txn.wallet_ref ?? '—'}</dd>
            <dt>User</dt>
            <dd>
              {txn.user_id ? (
                <Link href={`/users/${txn.user_id}`}>{txn.user_name ?? txn.user_id}</Link>
              ) : (
                '—'
              )}
            </dd>
          </dl>
        </div>
      </section>

      <div className="card">
        <h2>Ledger entries (double-entry)</h2>
        <div className="tovf">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Direction</th>
                <th>Amount</th>
                <th>Balance after</th>
                <th>Description</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {ledger.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No ledger entries — this transaction never moved money.
                  </td>
                </tr>
              )}
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td className="n">{timeAgo(e.created_at)}</td>
                  <td>
                    <span className={`chip ${e.direction}`}>{e.direction}</span>
                  </td>
                  <td className="mono">{money(txn.currency, e.amount)}</td>
                  <td className="mono">{money(txn.currency, e.balance_after)}</td>
                  <td>{e.description ?? '—'}</td>
                  <td className="mono n">{e.reference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Audit trail</h2>
        <ul className="audit-list">
          {audit.length === 0 && <li className="empty">No audit events.</li>}
          {audit.map((a) => (
            <li key={a.id}>
              <span className="n">{timeAgo(a.created_at)}</span>
              <span className="type">{titleize(a.action)}</span>
              <span className={`chip ${a.actor}`}>{a.actor}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
