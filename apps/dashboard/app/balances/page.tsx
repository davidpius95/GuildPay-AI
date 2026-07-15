import { getMerchantBalances } from '../../lib/api';
import { money } from '../../lib/format';

export const dynamic = 'force-dynamic';

export default async function Balances() {
  const { data, error } = await getMerchantBalances();

  return (
    <main className="wrap">
      <h1 className="page">Merchant balances</h1>
      <p className="sub">Flutterwave merchant float — available (withdrawable now) vs ledger (held).</p>

      {error && <div className="card empty">Couldn’t load balances — {error}</div>}

      {!error && (
        <section className="kpis">
          {(data ?? []).length === 0 && <div className="card empty">No balances to show.</div>}
          {(data ?? []).map((b) => (
            <div className="kpi" key={b.currency}>
              <div className="label">{b.currency} available</div>
              <div className="value">{money(b.currency, b.availableBalance)}</div>
              <div className="sub n">Ledger: {money(b.currency, b.ledgerBalance)}</div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
