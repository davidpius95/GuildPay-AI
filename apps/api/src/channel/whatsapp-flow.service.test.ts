import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { WhatsappFlowService, type FlowEnvelope, type FlowRequest } from './whatsapp-flow.service';

const PASSPHRASE = 'test-pass';

// A throwaway RSA keypair standing in for the Meta-registered business key.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
});

function makeService(overrides: Record<string, string> = {}): WhatsappFlowService {
  const values: Record<string, string> = {
    WHATSAPP_PIN_FLOW_ID: 'flow-123',
    WHATSAPP_FLOW_MODE: 'published',
    WHATSAPP_FLOW_PRIVATE_KEY: privateKey,
    WHATSAPP_FLOW_KEY_PASSPHRASE: PASSPHRASE,
    META_APP_SECRET: 'app-secret',
    ...overrides,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new WhatsappFlowService(config);
}

/** Build an envelope exactly the way Meta does, so we can test decryption. */
function sealRequest(request: FlowRequest): { envelope: FlowEnvelope; aesKey: Buffer; iv: Buffer } {
  const aesKey = randomBytes(16); // AES-128-GCM
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-gcm', aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(request), 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const encAesKey = publicEncrypt(
    { key: publicKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );
  return {
    envelope: {
      encrypted_flow_data: encrypted.toString('base64'),
      encrypted_aes_key: encAesKey.toString('base64'),
      initial_vector: iv.toString('base64'),
    },
    aesKey,
    iv,
  };
}

describe('WhatsappFlowService flow token', () => {
  it('round-trips a signed token and extracts the txn id', () => {
    const svc = makeService();
    const token = svc.signFlowToken('txn-abc');
    expect(svc.verifyFlowToken(token)).toBe('txn-abc');
  });

  it('rejects a tampered or malformed token', () => {
    const svc = makeService();
    const token = svc.signFlowToken('txn-abc');
    expect(svc.verifyFlowToken(token.replace('txn-abc', 'txn-evil'))).toBeNull();
    expect(svc.verifyFlowToken(`${token}x`)).toBeNull();
    expect(svc.verifyFlowToken('no-dot')).toBeNull();
    expect(svc.verifyFlowToken(undefined)).toBeNull();
  });
});

describe('WhatsappFlowService crypto', () => {
  it('decrypts a Meta-style envelope', () => {
    const svc = makeService();
    const request: FlowRequest = {
      version: '3.0',
      action: 'data_exchange',
      screen: 'PIN_SCREEN',
      data: { pin: '1234' },
      flow_token: 'tok',
    };
    const { envelope } = sealRequest(request);
    const { request: decrypted } = svc.decryptRequest(envelope);
    expect(decrypted).toEqual(request);
  });

  it('encrypts a response the client can decrypt (flipped IV, same AES key)', () => {
    const svc = makeService();
    const { envelope, aesKey, iv } = sealRequest({ version: '3.0', action: 'ping' });
    const { aesKey: recoveredKey, iv: recoveredIv } = svc.decryptRequest(envelope);

    const b64 = svc.encryptResponse({ version: '3.0', data: { status: 'active' } }, recoveredKey, recoveredIv);

    // Client-side decrypt: flip the IV, split the trailing 16-byte GCM tag.
    const flippedIv = Buffer.from(iv.map((b) => b ^ 0xff));
    const buf = Buffer.from(b64, 'base64');
    const tag = buf.subarray(buf.length - 16);
    const body = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv('aes-128-gcm', aesKey, flippedIv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8');
    expect(JSON.parse(plain)).toEqual({ version: '3.0', data: { status: 'active' } });
  });

  it('throws FlowDecryptError on a garbage envelope', () => {
    const svc = makeService();
    expect(() =>
      svc.decryptRequest({ encrypted_aes_key: 'AA', encrypted_flow_data: 'AA', initial_vector: 'AA' }),
    ).toThrow();
  });
});

describe('WhatsappFlowService.buildPinFlowMessage', () => {
  it('builds a flow message bound to the txn', () => {
    const svc = makeService();
    const msg = svc.buildPinFlowMessage('234800', 'txn-1', 'Approve?');
    expect(msg).toMatchObject({
      to: '234800',
      kind: 'flow',
      flowId: 'flow-123',
      screenId: 'PIN_SCREEN',
      buttonTitle: 'Verify Transaction',
      mode: 'published',
    });
    expect(svc.verifyFlowToken(msg.flowToken)).toBe('txn-1');
  });

  it('isEnabled reflects the Flow ID presence', () => {
    expect(makeService().isEnabled()).toBe(true);
    expect(makeService({ WHATSAPP_PIN_FLOW_ID: '' }).isEnabled()).toBe(false);
  });
});
