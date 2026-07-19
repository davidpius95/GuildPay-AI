import {
  getVolumeByType,
  getStatusBreakdown,
  getOnboardingFunnel,
  getRevenueByCurrency,
  getTopRecipients,
  getVolumeLast7Days,
} from '../../lib/queries';
import { money, titleize } from '../../lib/format';

export const dynamic = 'force-dynamic';

export default async function Analytics() {
  const [byType, byStatus, funnel, revenue, topRecipients, volume] = await Promise.all([
    getVolumeByType(),
    getStatusBreakdown(),
    getOnboardingFunnel(),
    getRevenueByCurrency(),
    getTopRecipients(8),
    getVolumeLast7Days(),
  ]);

  const totalTxns = byStatus.reduce((s, r) => s + r.count, 0);
  const completed = byStatus.find((s) => s.status === 'completed')?.count ?? 0;
  const failed = byStatus.find((s) => s.status === 'failed')?.count ?? 0;
  const successRate = totalTxns ? Math.round((completed / totalTxns) * 100) : 0;
  const maxType = Math.max(1, ...byType.map((t) => t.count));
  const maxVol = Math.max(1, ...volume.map((v) => Number(v.volume)));
  const maxFunnel = Math.max(1, ...funnel.map((f) => f.count));

  return (
    <main className="wrap">
      <h1 className="page">Analytics</h1>
      <p className="sub">Transaction health, revenue, and onboarding funnel across all markets.</p>

      <section className="kpis">
        <div className="kpi">
          <div className="label">Success rate</div>
          <div className="value">
            {successRate}% <small>· {completed}/{totalTxns}</small>
          </div>
        </div>
        <div className="kpi">
          <div className="label">Failed</div>
          <div className="value">{failed}</div>
        </div>
        {revenue.map((r) => (
          <div className="kpi" key={r.currency}>
            <div className="label">Fees ({r.currency})</div>
            <div className="value">{money(r.currency, r.fees)}</div>
          </div>
        ))}
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
          <h2>Transactions by type</h2>
          {byType.length === 0 && <div className="empty">No transactions yet.</div>}
          {byType.map((t) => (
            <div className="hbar-row" key={t.type}>
              <span className="hbar-label">{titleize(t.type)}</span>
              <span className="hbar-track">
                <span className="hbar-fill" style={{ width: `${(t.count / maxType) * 100}%` }} />
              </span>
              <span className="hbar-val mono">{t.count}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid2">
        <div className="card">
          <h2>Onboarding funnel</h2>
          {funnel.map((f) => (
            <div className="hbar-row" key={f.onboarding_step}>
              <span className="hbar-label">{titleize(f.onboarding_step)}</span>
              <span className="hbar-track">
                <span className="hbar-fill" style={{ width: `${(f.count / maxFunnel) * 100}%` }} />
              </span>
              <span className="hbar-val mono">{f.count}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>Revenue by currency</h2>
          <div className="tovf">
            <table>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Completed</th>
                  <th>Volume</th>
                  <th>Fees</th>
                </tr>
              </thead>
              <tbody>
                {revenue.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      No revenue yet.
                    </td>
                  </tr>
                )}
                {revenue.map((r) => (
                  <tr key={r.currency}>
                    <td>
                      <strong>{r.currency}</strong>
                    </td>
                    <td className="mono">{r.completed}</td>
                    <td className="mono">{money(r.currency, r.volume)}</td>
                    <td className="mono">{money(r.currency, r.fees)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div className="card">
        <h2>Top recipients</h2>
        <div className="tovf">
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Reference</th>
                <th>Transfers</th>
                <th>Volume</th>
              </tr>
            </thead>
            <tbody>
              {topRecipients.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No completed transfers yet.
                  </td>
                </tr>
              )}
              {topRecipients.map((r, i) => (
                <tr key={`${r.recipient_ref ?? r.recipient_name ?? i}`}>
                  <td>{r.recipient_name ?? '—'}</td>
                  <td className="mono n">{r.recipient_ref ?? '—'}</td>
                  <td className="mono">{r.count}</td>
                  <td className="mono">{money('NGN', r.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
