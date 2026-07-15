import { getDisputes } from '../../lib/api';
import { money, titleize } from '../../lib/format';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function badgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('won') || s.includes('closed')) return 'completed';
  if (s.includes('lost') || s.includes('failed')) return 'failed';
  return 'pending';
}

export default async function Disputes() {
  const { data, error } = await getDisputes();
  const rows = data ?? [];
  const open = rows.filter((d) => d.status.toLowerCase() === 'pending').length;

  return (
    <main className="wrap">
      <h1 className="page">Disputes</h1>
      <p className="sub">
        Chargebacks raised by customers.{rows.length > 0 && ` ${open} awaiting response.`}
      </p>

      {error && <div className="card empty">Couldn’t load disputes — {error}</div>}

      {!error && (
        <div className="card">
          <div className="tovf">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Reason</th>
                  <th>Customer</th>
                  <th>Respond by</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">No disputes 🎉</td>
                  </tr>
                )}
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="mono n">{d.id}</td>
                    <td><span className={`badge ${badgeClass(d.status)}`}>{titleize(d.status)}</span></td>
                    <td className="mono">{money(d.currency, d.amount)}</td>
                    <td>{d.reason ?? '—'}</td>
                    <td className="n">{d.customerEmail ?? '—'}</td>
                    <td className="n">{fmtDate(d.dueDate)}</td>
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
