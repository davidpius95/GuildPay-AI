import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * PinService — hashes and verifies the 4-digit transaction PIN.
 * scrypt (node:crypto, no deps) with a per-user random salt; stored as
 * `s2$<salt-hex>$<hash-hex>` in users.pin_hash. The raw PIN is never
 * logged, audited, or stored (CLAUDE.md guardrail).
 */
@Injectable()
export class PinService {
  hash(pin: string): string {
    const salt = randomBytes(16);
    const dk = scryptSync(pin, salt, 32);
    return `s2$${salt.toString('hex')}$${dk.toString('hex')}`;
  }

  verify(pin: string, stored: string | null): boolean {
    if (!stored) return false;
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 's2' || !saltHex || !hashHex) return false;
    const dk = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
    const expected = Buffer.from(hashHex, 'hex');
    return dk.length === expected.length && timingSafeEqual(dk, expected);
  }

  /** A valid transaction PIN is exactly 4 digits. */
  isValidFormat(pin: string): boolean {
    return /^\d{4}$/.test(pin);
  }
}
