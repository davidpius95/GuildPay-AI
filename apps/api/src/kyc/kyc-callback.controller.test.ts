import { describe, expect, it } from 'vitest';
import { KycCallbackController } from './kyc-callback.controller';

describe('KycCallbackController', () => {
  it('returns a self-contained HTML landing page', () => {
    const html = new KycCallbackController().bvnCallback();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Verification received');
    expect(html).toContain('WhatsApp');
    // No secrets / external calls — purely informational.
    expect(html).not.toContain('FLW');
  });
});
