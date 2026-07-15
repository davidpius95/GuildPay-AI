import { getUsers } from '../../lib/queries';
import { money, timeAgo } from '../../lib/format';
import { resetUser, deleteUser, demoReset } from './actions';

export const dynamic = 'force-dynamic';

function maskPhone(p: string): string {
  return p.length > 6 ? `${p.slice(0, 5)}…${p.slice(-3)}` : p;
}

export default async function Users() {
  const users = await getUsers();

  return (
    <main className="wrap">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page">Users</h1>
          <p className="sub">{users.length} users · reset returns a user to fresh onboarding; delete removes them entirely.</p>
        </div>
        <form action={demoReset}>
          <button
            className="btn danger"
            type="submit"
            title="Wipe ALL users and data (demo reset)"
          >
            Demo reset (wipe all)
          </button>
        </form>
      </div>

      <div className="card">
        <div className="tovf">
          <table>
            <thead>
              <tr>
                <th>Joined</th>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Market</th>
                <th>KYC</th>
                <th>Account</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty">
                    No users yet.
                  </td>
                </tr>
              )}
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="n">{timeAgo(u.created_at)}</td>
                  <td>{u.full_name ?? <span className="n">—</span>}</td>
                  <td className="mono n">{maskPhone(u.wa_phone)}</td>
                  <td className="n">{u.email ?? '—'}</td>
                  <td>{u.market ?? '—'}</td>
                  <td>
                    <span className={`badge ${u.kyc_status === 'verified' ? 'completed' : u.kyc_status === 'failed' ? 'failed' : 'pending'}`}>
                      {u.kyc_status}
                    </span>
                  </td>
                  <td className="mono n">
                    {u.virtual_account_number ? (
                      <>
                        {u.virtual_account_number}
                        <div style={{ fontSize: '0.8em', color: '#666' }}>{u.virtual_bank_name}</div>
                      </>
                    ) : (
                      u.wallet_ref ?? '—'
                    )}
                  </td>
                  <td className="mono">{u.balance ? money(u.currency ?? 'NGN', u.balance) : '—'}</td>
                  <td>
                    <span className={`badge ${u.status === 'active' ? 'completed' : 'pending'}`}>{u.status}</span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <form action={resetUser}>
                        <input type="hidden" name="id" value={u.id} />
                        <button className="btn" type="submit">
                          Reset
                        </button>
                      </form>
                      <form action={deleteUser}>
                        <input type="hidden" name="id" value={u.id} />
                        <button className="btn danger" type="submit">
                          Delete
                        </button>
                      </form>
                    </div>
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
