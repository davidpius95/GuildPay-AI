import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'GuildPay AI — Admin',
  description: 'Admin/partner dashboard for GuildPay AI',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <div className="brand">
            Guild<span>Pay</span> Admin
          </div>
          <a className="link" href="/">
            Overview
          </a>
          <a className="link" href="/analytics">
            Analytics
          </a>
          <a className="link" href="/transactions">
            Transactions
          </a>
          <a className="link" href="/users">
            Users
          </a>
          <a className="link" href="/balances">
            Balances
          </a>
          <a className="link" href="/settlements">
            Settlements
          </a>
          <a className="link" href="/disputes">
            Disputes
          </a>
          <a className="link" href="/audit">
            Audit
          </a>
          <a className="link" href="/tools">
            Tools
          </a>
          <div className="spacer" />
          <div className="live">
            <span className="dot" /> live
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
