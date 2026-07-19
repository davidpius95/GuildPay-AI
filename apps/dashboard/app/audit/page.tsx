import Link from 'next/link';
import { listAuditEvents } from '../../lib/queries';
import { timeAgo, titleize } from '../../lib/format';

export const dynamic = 'force-dynamic';

const ACTORS = ['user', 'system', 'admin'];

interface SP {
  actor?: string;
  action?: string;
  page?: string;
}

export default async function Audit({ searchParams }: { searchParams: SP }) {
  const page = Number(searchParams.page) || 1;
  const { rows, total, pageSize } = await listAuditEvents({
    actor: searchParams.actor,
    action: searchParams.action,
    page,
  });
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const pageHref = (p: number) => {
    const sp = new URLSearchParams();
    if (searchParams.actor) sp.set('actor', searchParams.actor);
    if (searchParams.action) sp.set('action', searchParams.action);
    sp.set('page', String(p));
    return `/audit?${sp.toString()}`;
  };

  return (
    <main className="wrap">
      <h1 className="page">Audit log</h1>
      <p className="sub">{total} events · every sensitive action is recorded here.</p>

      <form className="filters" method="get">
        <input name="action" defaultValue={searchParams.action ?? ''} placeholder="Search action…" />
        <select name="actor" defaultValue={searchParams.actor ?? ''}>
          <option value="">All actors</option>
          {ACTORS.map((a) => (
            <option key={a} value={a}>
              {titleize(a)}
            </option>
          ))}
        </select>
        <button className="btn primary" type="submit">
          Filter
        </button>
        <Link className="btn" href="/audit">
          Clear
        </Link>
      </form>

      <div className="card">
        <div className="tovf">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>User</th>
                <th>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No audit events.
                  </td>
                </tr>
              )}
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="n">{timeAgo(a.created_at)}</td>
                  <td>
                    <span className={`chip ${a.actor}`}>{a.actor}</span>
                  </td>
                  <td className="type">{titleize(a.action)}</td>
                  <td>
                    {a.entity === 'transaction' && a.entity_id ? (
                      <Link href={`/transactions/${a.entity_id}`}>{a.entity}</Link>
                    ) : a.entity === 'user' && a.entity_id ? (
                      <Link href={`/users/${a.entity_id}`}>{a.entity}</Link>
                    ) : (
                      (a.entity ?? '—')
                    )}
                  </td>
                  <td>
                    {a.user_id ? (
                      <Link href={`/users/${a.user_id}`}>{a.user_name ?? a.user_id.slice(0, 8)}</Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="mono n meta">
                    {a.metadata ? JSON.stringify(a.metadata).slice(0, 80) : '—'}
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
