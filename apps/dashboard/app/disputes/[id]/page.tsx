import Link from 'next/link';
import { getDispute } from '../../../lib/api';
import { money, titleize } from '../../../lib/format';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function badgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('won') || s.includes('closed')) return 'completed';
  if (s.includes('lost') || s.includes('failed')) return 'failed';
  return 'pending';
}

export default async function DisputeDetail({ params }: { params: { id: string } }) {
  const { data: d, error } = await getDispute(params.id);

  return (
    <main className="wrap">
      <p className="crumb">
        <Link href="/disputes">← Disputes</Link>
      </p>
      <h1 className="page">Dispute {params.id}</h1>

      {error && <div className="card empty">Couldn&apos;t load dispute — {error}</div>}

      {d && (
        <div className="card">
          <div className="detail-head">
            <h2>{money(d.currency, d.amount)}</h2>
            <span className={`badge ${badgeClass(d.status)}`}>{titleize(d.status)}</span>
          </div>
          <dl className="kv">
            <dt>Reason</dt>
            <dd>{d.reason ?? '—'}</dd>
            <dt>Customer</dt>
            <dd>{d.customerEmail ?? '—'}</dd>
            <dt>Transaction ref</dt>
            <dd className="mono">{d.txRef ?? '—'}</dd>
            <dt>Respond by</dt>
            <dd>{fmtDate(d.dueDate)}</dd>
            <dt>Created</dt>
            <dd>{fmtDate(d.createdAt)}</dd>
          </dl>
        </div>
      )}
    </main>
  );
}
