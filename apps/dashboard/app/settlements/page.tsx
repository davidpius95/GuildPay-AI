import { getSettlements } from '../../lib/api';
import { money, titleize } from '../../lib/format';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

export default async function Settlements() {
  const { data, error } = await getSettlements();
  const rows = data ?? [];

  return (
    <main className="wrap">
      <h1 className="page">Settlements</h1>
      <p className="sub">When funds settle from Flutterwave into the corporate bank account.</p>

      {error && <div className="card empty">Couldn’t load settlements — {error}</div>}

      {!error && (
        <div className="card">
          <div className="tovf">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Net</th>
                  <th>Gross</th>
                  <th>Fees</th>
                  <th>Settles</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">No settlements yet.</td>
                  </tr>
                )}
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="mono n">{s.id}</td>
                    <td><span className={`badge ${s.status === 'completed' ? 'completed' : 'pending'}`}>{titleize(s.status)}</span></td>
                    <td className="mono">{money(s.currency, s.netAmount)}</td>
                    <td className="mono n">{money(s.currency, s.grossAmount)}</td>
                    <td className="mono n">{money(s.currency, s.appFee + s.merchantFee)}</td>
                    <td className="n">{fmtDate(s.dueDate)}</td>
                    <td className="n">{s.bankName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
