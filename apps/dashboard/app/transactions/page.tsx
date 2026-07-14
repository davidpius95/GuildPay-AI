import { getRecentTransactions } from '../../lib/queries';
import { money, timeAgo, titleize } from '../../lib/format';

export const dynamic = 'force-dynamic';

export default async function Transactions() {
  const txns = await getRecentTransactions(100);

  return (
    <main className="wrap">
      <h1 className="page">Transactions</h1>
      <p className="sub">Most recent {txns.length} transactions across all wallets.</p>

      <div className="card">
        <div className="tovf">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Channel</th>
                <th>Amount</th>
                <th>To</th>
                <th>Wallet</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {txns.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No transactions yet.
                  </td>
                </tr>
              )}
              {txns.map((t) => (
                <tr key={t.id}>
                  <td className="n">{timeAgo(t.created_at)}</td>
                  <td className="type">{titleize(t.type)}</td>
                  <td className="type">{t.channel}</td>
                  <td className="mono">{money(t.currency, t.amount)}</td>
                  <td>{t.recipient_name ?? '—'}</td>
                  <td className="mono n">{t.wallet_ref ?? '—'}</td>
                  <td>
                    <span className={`badge ${t.status}`}>{titleize(t.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
