import { CURRENCY_META } from '@guildpay/shared';

export default function Home() {
  return (
    <main style={{ padding: '3rem', maxWidth: 720 }}>
      <h1>GuildPay AI — Admin Dashboard</h1>
      <p>Week 0 scaffold. Users, transactions, batches, support and risk pages land in Week 1+.</p>
      <p>
        Supported rails:{' '}
        {Object.entries(CURRENCY_META)
          .map(([code, meta]) => `${code} (${meta.symbol})`)
          .join(' · ')}
      </p>
    </main>
  );
}
