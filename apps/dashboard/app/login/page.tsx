export const dynamic = 'force-dynamic';

export default function Login({ searchParams }: { searchParams: { e?: string } }) {
  return (
    <main style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form
        action="/api/login"
        method="POST"
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '2rem',
          width: 320,
          maxWidth: '90vw',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: '1.2rem', marginBottom: '0.25rem' }}>
          Guild<span style={{ color: 'var(--accent)' }}>Pay</span> Admin
        </div>
        <p className="sub" style={{ marginBottom: '1.25rem' }}>Sign in to continue.</p>
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          style={{
            width: '100%',
            padding: '0.65rem 0.8rem',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--panel-2)',
            color: 'var(--text)',
            fontSize: '0.95rem',
            marginBottom: '0.9rem',
          }}
        />
        {searchParams?.e && (
          <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginBottom: '0.9rem' }}>
            Incorrect password.
          </div>
        )}
        <button
          type="submit"
          style={{
            width: '100%',
            padding: '0.65rem',
            borderRadius: 8,
            border: 'none',
            background: 'var(--accent)',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.95rem',
            cursor: 'pointer',
          }}
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
