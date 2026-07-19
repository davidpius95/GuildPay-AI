import Link from 'next/link';
import { searchTransactions } from '../../lib/queries';
import { money, timeAgo, titleize } from '../../lib/format';

export const dynamic = 'force-dynamic';

const STATUSES = ['pending_confirmation', 'pending_otp', 'completed', 'failed', 'cancelled', 'expired'];
const TYPES = ['funding', 'p2p_transfer', 'bank_transfer', 'airtime', 'data', 'bill_payment', 'refund'];

interface SP {
  q?: string;
  status?: string;
  type?: string;
  page?: string;
}

export default async function Transactions({ searchParams }: { searchParams: SP }) {
  const page = Number(searchParams.page) || 1;
  const { rows, total, pageSize } = await searchTransactions({
    q: searchParams.q,
    status: searchParams.status,
    type: searchParams.type,
    page,
  });
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const pageHref = (p: number) => {
    const sp = new URLSearchParams();
    if (searchParams.q) sp.set('q', searchParams.q);
    if (searchParams.status) sp.set('status', searchParams.status);
    if (searchParams.type) sp.set('type', searchParams.type);
    sp.set('page', String(p));
    return `/transactions?${sp.toString()}`;
  };

  return (
    <main className="wrap">
      <h1 className="page">Transactions</h1>
      <p className="sub">{total} transactions match your filters.</p>

      <form className="filters" method="get">
        <input name="q" defaultValue={searchParams.q ?? ''} placeholder="Search recipient, ref, provider…" />
        <select name="status" defaultValue={searchParams.status ?? ''}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleize(s)}
            </option>
          ))}
        </select>
        <select name="type" defaultValue={searchParams.type ?? ''}>
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {titleize(t)}
            </option>
          ))}
        </select>
        <button className="btn primary" type="submit">
          Filter
        </button>
        <Link className="btn" href="/transactions">
          Clear
        </Link>
      </form>

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
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No matching transactions.
                  </td>
                </tr>
              )}
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="n">{timeAgo(t.created_at)}</td>
                  <td className="type">
                    <Link href={`/transactions/${t.id}`}>{titleize(t.type)}</Link>
                  </td>
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

      {pages > 1 && (
        <div className="pager">
          {page > 1 && (
            <Link className="btn" href={pageHref(page - 1)}>
              ← Prev
            </Link>
          )}
          <span className="n">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link className="btn" href={pageHref(page + 1)}>
              Next →
            </Link>
          )}
        </div>
      )}
    </main>
  );
}
