import { getBanks, nameEnquiry } from '../../lib/api';

export const dynamic = 'force-dynamic';

interface SP {
  account?: string;
  bankCode?: string;
}

export default async function Tools({ searchParams }: { searchParams: SP }) {
  const banksRes = await getBanks();
  const banks = banksRes.data ?? [];

  const hasQuery = Boolean(searchParams.account && searchParams.bankCode);
  const result = hasQuery
    ? await nameEnquiry(searchParams.account as string, searchParams.bankCode as string)
    : null;

  return (
    <main className="wrap">
      <h1 className="page">Tools · Name enquiry</h1>
      <p className="sub">
        Resolve the account holder&apos;s name for any Nigerian bank — the same read-only check a
        payout runs, so you can verify an account without sending money.
      </p>

      {banksRes.error && (
        <div className="card notice">
          Bank list unavailable: {banksRes.error}. Check the Flutterwave keys on the API.
        </div>
      )}

      <div className="card">
        <form className="form" method="get">
          <div className="form-row">
            <label>
              Account number
              <input name="account" defaultValue={searchParams.account ?? ''} placeholder="0690000031" />
            </label>
            <label>
              Bank
              <select name="bankCode" defaultValue={searchParams.bankCode ?? ''}>
                <option value="">Select a bank…</option>
                {banks.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="btn primary" type="submit" disabled={banks.length === 0}>
            Resolve name
          </button>
        </form>
      </div>

      {result && (
        <div className="card">
          <h2>Result</h2>
          {result.error ? (
            <div className="notice">{result.error}</div>
          ) : result.data?.accountName ? (
            <dl className="kv">
              <dt>Account name</dt>
              <dd>
                <strong>{result.data.accountName}</strong>
              </dd>
              <dt>Account number</dt>
              <dd className="mono">{result.data.accountNumber ?? searchParams.account}</dd>
            </dl>
          ) : (
            <div className="notice">Could not resolve this account. Check the number and bank.</div>
          )}
        </div>
      )}
    </main>
  );
}
