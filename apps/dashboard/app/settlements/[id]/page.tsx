import Link from 'next/link';
import { getSettlement } from '../../../lib/api';
import { money, titleize } from '../../../lib/format';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

export default async function SettlementDetail({ params }: { params: { id: string } }) {
  const { data: s, error } = await getSettlement(params.id);

  return (
    <main className="wrap">
      <p className="crumb">
        <Link href="/settlements">← Settlements</Link>
      </p>
      <h1 className="page">Settlement {params.id}</h1>

      {error && <div className="card empty">Couldn&apos;t load settlement — {error}</div>}

      {s && (
        <div className="card">
          <div className="detail-head">
            <h2>{money(s.currency, s.netAmount)} net</h2>
            <span className={`badge ${s.status === 'completed' ? 'completed' : 'pending'}`}>
              {titleize(s.status)}
            </span>
          </div>
          <dl className="kv">
            <dt>Gross amount</dt>
            <dd className="mono">{money(s.currency, s.grossAmount)}</dd>
            <dt>App fee</dt>
            <dd className="mono">{money(s.currency, s.appFee)}</dd>
            <dt>Merchant fee</dt>
            <dd className="mono">{money(s.currency, s.merchantFee)}</dd>
            <dt>Net amount</dt>
            <dd className="mono">
              <strong>{money(s.currency, s.netAmount)}</strong>
            </dd>
            <dt>Settles to</dt>
            <dd>
              {s.bankName ?? '—'} {s.accountNumber ? `· ${s.accountNumber}` : ''}
            </dd>
            <dt>Due date</dt>
            <dd>{fmtDate(s.dueDate)}</dd>
            <dt>Created</dt>
            <dd>{fmtDate(s.createdAt)}</dd>
          </dl>
        </div>
      )}
    </main>
  );
}
