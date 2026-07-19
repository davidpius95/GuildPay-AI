import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getUser,
  getUserTransactions,
  getUserBeneficiaries,
  getUserAudit,
} from '../../../lib/queries';
import { money, timeAgo, titleize } from '../../../lib/format';
import { updateUser, deleteBeneficiary, resetUser, deleteUser } from '../actions';

export const dynamic = 'force-dynamic';

const STATUSES = ['pending', 'active', 'frozen', 'closed'];
const KYC_STATUSES = ['pending', 'verified', 'failed'];

export default async function UserDetail({ params }: { params: { id: string } }) {
  const user = await getUser(params.id);
  if (!user) notFound();

  const [txns, beneficiaries, audit] = await Promise.all([
    getUserTransactions(params.id, 25),
    getUserBeneficiaries(params.id),
    getUserAudit(params.id, 25),
  ]);

  return (
    <main className="wrap">
      <p className="crumb">
        <Link href="/users">← Users</Link>
      </p>
      <div className="detail-head">
        <div>
          <h1 className="page">{user.full_name ?? 'Unnamed user'}</h1>
          <p className="sub mono">{user.wa_phone}</p>
        </div>
        <span className={`badge ${user.status}`}>{titleize(user.status)}</span>
      </div>

      <section className="grid2">
        <div className="card">
          <h2>Edit profile</h2>
          <form action={updateUser} className="form">
            <input type="hidden" name="id" value={user.id} />
            <label>
              Full name
              <input name="full_name" defaultValue={user.full_name ?? ''} placeholder="—" />
            </label>
            <label>
              Email
              <input name="email" type="email" defaultValue={user.email ?? ''} placeholder="—" />
            </label>
            <div className="form-row">
              <label>
                Status
                <select name="status" defaultValue={user.status}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {titleize(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                KYC status
                <select name="kyc_status" defaultValue={user.kyc_status}>
                  {KYC_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {titleize(s)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn primary" type="submit">
              Save changes
            </button>
          </form>
        </div>

        <div className="card">
          <h2>Wallet</h2>
          <dl className="kv">
            <dt>Reference</dt>
            <dd className="mono">{user.wallet_ref ?? '—'}</dd>
            <dt>Balance</dt>
            <dd className="mono">
              {user.currency && user.balance ? money(user.currency, user.balance) : '—'}
            </dd>
            <dt>Virtual account</dt>
            <dd className="mono">
              {user.virtual_account_number
                ? `${user.virtual_account_number} · ${user.virtual_bank_name ?? ''}`
                : '—'}
            </dd>
            <dt>Market</dt>
            <dd>{user.market ?? '—'}</dd>
            <dt>Onboarding</dt>
            <dd>{titleize(user.onboarding_step)}</dd>
            <dt>Joined</dt>
            <dd>{timeAgo(user.created_at)}</dd>
          </dl>
          <div className="danger-zone">
            <form action={resetUser}>
              <input type="hidden" name="id" value={user.id} />
              <button className="btn" type="submit" title="Reset to fresh onboarding">
                Reset user
              </button>
            </form>
            <form action={deleteUser}>
              <input type="hidden" name="id" value={user.id} />
              <button className="btn danger" type="submit" title="Delete user and all data">
                Delete user
              </button>
            </form>
          </div>
        </div>
      </section>

      <div className="card">
        <h2>Beneficiaries ({beneficiaries.length})</h2>
        <div className="tovf">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Reference</th>
                <th>Bank code</th>
                <th>Currency</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {beneficiaries.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No saved beneficiaries.
                  </td>
                </tr>
              )}
              {beneficiaries.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td className="mono">{b.ref}</td>
                  <td className="mono n">{b.bank_code ?? '—'}</td>
                  <td>{b.currency}</td>
                  <td>
                    <form action={deleteBeneficiary}>
                      <input type="hidden" name="id" value={user.id} />
                      <input type="hidden" name="beneficiaryId" value={b.id} />
                      <button className="btn small danger" type="submit">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section className="grid2">
        <div className="card">
          <h2>Recent transactions</h2>
          <div className="tovf">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {txns.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      No transactions.
                    </td>
                  </tr>
                )}
                {txns.map((t) => (
                  <tr key={t.id}>
                    <td className="n">{timeAgo(t.created_at)}</td>
                    <td>
                      <Link href={`/transactions/${t.id}`}>{titleize(t.type)}</Link>
                    </td>
                    <td className="mono">{money(t.currency, t.amount)}</td>
                    <td>
                      <span className={`badge ${t.status}`}>{titleize(t.status)}</span>
                    </td>
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
      </section>
    </main>
  );
}
