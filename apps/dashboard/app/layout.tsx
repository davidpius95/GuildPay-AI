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
          <a className="link" href="/transactions">
            Transactions
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
