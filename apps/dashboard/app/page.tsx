import {
  getOverview,
  getBalancesByCurrency,
  getVolumeLast7Days,
  getRecentTransactions,
} from '../lib/queries';
import { money, timeAgo, titleize } from '../lib/format';

// Always render fresh from the DB (no static caching) — this is a live admin view.
export const dynamic = 'force-dynamic';

export default async function Overview() {
  const [ov, byCur, volume, recent] = await Promise.all([
    getOverview(),
    getBalancesByCurrency(),
    getVolumeLast7Days(),
    getRecentTransactions(8),
  ]);

  const maxVol = Math.max(1, ...volume.map((v) => Number(v.volume)));

  return (
    <main className="wrap">
      <h1 className="page">Overview</h1>
      <p className="sub">Live activity across the GuildPay wallet — {new Date().toUTCString()}</p>

      <section className="kpis">
        <div className="kpi">
          <div className="label">Users</div>
          <div className="value">
            {ov.users} <small>· {ov.activeUsers} active</small>
          </div>
        </div>
        <div className="kpi">
          <div className="label">Wallets</div>
          <div className="value">{ov.wallets}</div>
        </div>
        <div className="kpi">
          <div className="label">Transactions</div>
          <div className="value">{ov.txnCount}</div>
        </div>
        <div className="kpi">
          <div className="label">Markets</div>
          <div className="value">{byCur.length}</div>
        </div>
      </section>

      <section className="grid2">
        <div className="card">
          <h2>Completed volume — last 7 days</h2>
          <div className="bars">
            {volume.map((v) => (
              <div className="bar-col" key={v.day}>
                <div
                  className="bar"
                  style={{ height: `${(Number(v.volume) / maxVol) * 100}%` }}
                  title={`${v.completed} txns`}
                />
                <div className="d">{v.day.split(' ')[1]}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h2>Balances by currency</h2>
          {byCur.length === 0 && <div className="empty">No wallets yet.</div>}
          {byCur.map((c) => (
            <div className="cur-row" key={c.currency}>
              <span>
                <strong>{c.currency}</strong> <span className="n">· {c.wallets} wallets</span>
              </span>
              <span className="amt mono">{money(c.currency, c.balance)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="card">
        <h2>Recent activity</h2>
        <div className="tovf">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Amount</th>
                <th>To</th>
                <th>Wallet</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No transactions yet.
                  </td>
                </tr>
              )}
              {recent.map((t) => (
                <tr key={t.id}>
                  <td className="n">{timeAgo(t.created_at)}</td>
                  <td className="type">{titleize(t.type)}</td>
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
