import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  privateDecrypt,
  timingSafeEqual,
  type CipherGCM,
  type DecipherGCM,
  type KeyObject,
} from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OutboundFlow } from './channel-adapter';

/** Reserved WhatsApp Flow terminal screen that closes the modal. */
export const FLOW_SUCCESS_SCREEN = 'SUCCESS';
/** The single data-entry screen of the PIN flow (must match pin-flow.json). */
export const PIN_SCREEN = 'PIN_SCREEN';

/** Decrypted body of a WhatsApp Flow data-exchange request. */
export interface FlowRequest {
  version: string;
  action: 'INIT' | 'BACK' | 'data_exchange' | 'ping';
  screen?: string;
  data?: Record<string, unknown>;
  flow_token?: string;
}

/** The encrypted envelope Meta POSTs to the Flow endpoint. */
export interface FlowEnvelope {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

/** Thrown when the envelope cannot be decrypted — the endpoint must reply 421. */
export class FlowDecryptError extends Error {}

/**
 * WhatsappFlowService — the crypto + token layer for WhatsApp Flows.
 *
 * Encrypted data-exchange Flows work like this:
 *   1. Meta encrypts a one-time AES key with our RSA public key (RSA-OAEP/SHA-256)
 *      and the request body with that AES key (AES-GCM).
 *   2. We decrypt the AES key with our private key, then the body with the AES key.
 *   3. We reply with the response body encrypted under the SAME AES key but with a
 *      bit-flipped IV (Meta's required scheme), returned as raw base64 text.
 *
 * The raw PIN only ever exists inside this decrypted exchange — never in the chat
 * thread, never logged (CLAUDE.md guardrail).
 */
@Injectable()
export class WhatsappFlowService {
  private readonly logger = new Logger(WhatsappFlowService.name);
  private privateKeyCache: KeyObject | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The Flow is active only when a Flow ID is configured. */
  isEnabled(): boolean {
    return !!this.config.get<string>('WHATSAPP_PIN_FLOW_ID');
  }

  /** Build the outbound PIN Flow message for a pending transaction. */
  buildPinFlowMessage(to: string, txnId: string, body: string): OutboundFlow {
    const mode = this.config.get<string>('WHATSAPP_FLOW_MODE') === 'draft' ? 'draft' : 'published';
    return {
      to,
      kind: 'flow',
      body,
      flowId: this.config.get<string>('WHATSAPP_PIN_FLOW_ID') ?? '',
      flowToken: this.signFlowToken(txnId),
      screenId: PIN_SCREEN,
      buttonTitle: 'Verify Transaction',
      mode,
    };
  }

  /** Build the outbound PIN Flow message for first-time PIN setup during onboarding. */
  buildSetupPinFlowMessage(to: string, userId: string, body: string): OutboundFlow {
    const mode = this.config.get<string>('WHATSAPP_FLOW_MODE') === 'draft' ? 'draft' : 'published';
    return {
      to,
      kind: 'flow',
      body,
      flowId: this.config.get<string>('WHATSAPP_PIN_FLOW_ID') ?? '',
      flowToken: this.signFlowToken(`onboard_${userId}`),
      screenId: PIN_SCREEN,
      buttonTitle: 'Set PIN',
      mode,
    };
  }

  // ── flow token (binds a flow response to a specific pending txn) ────────────

  /** `<txnId>.<hmac>` — signed with the app secret; opaque to the client. */
  signFlowToken(txnId: string): string {
    return `${txnId}.${this.tokenSig(txnId)}`;
  }

  /** Verify + extract the txn id from a flow token, or null if tampered/invalid. */
  verifyFlowToken(token: string | undefined): string | null {
    if (!token) return null;
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return null;
    const txnId = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = this.tokenSig(txnId);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return txnId;
  }

  private tokenSig(txnId: string): string {
    const secret =
      this.config.get<string>('WHATSAPP_FLOW_TOKEN_SECRET') ??
      this.config.get<string>('META_APP_SECRET') ??
      'guildpay-dev-secret';
    return createHmac('sha256', secret).update(txnId).digest('hex');
  }

  // ── encrypted data-exchange ─────────────────────────────────────────────────

  /**
   * Decrypt an incoming Flow envelope. Returns the parsed request plus the AES
   * key and IV needed to encrypt the matching response.
   */
  decryptRequest(envelope: FlowEnvelope): {
    request: FlowRequest;
    aesKey: Buffer;
    iv: Buffer;
  } {
    const privateKey = this.loadPrivateKey();
    let aesKey: Buffer;
    try {
      aesKey = privateDecrypt(
        { key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(envelope.encrypted_aes_key, 'base64'),
      );
    } catch (err) {
      throw new FlowDecryptError(`RSA decrypt of AES key failed: ${(err as Error).message}`);
    }

    const iv = Buffer.from(envelope.initial_vector, 'base64');
    const flowData = Buffer.from(envelope.encrypted_flow_data, 'base64');
    const TAG_LEN = 16;
    const tag = flowData.subarray(flowData.length - TAG_LEN);
    const body = flowData.subarray(0, flowData.length - TAG_LEN);
    try {
      const decipher = createDecipheriv(`aes-${aesKey.length * 8}-gcm`, aesKey, iv) as DecipherGCM;
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8');
      return { request: JSON.parse(plaintext) as FlowRequest, aesKey, iv };
    } catch (err) {
      throw new FlowDecryptError(`AES-GCM decrypt failed: ${(err as Error).message}`);
    }
  }

  /**
   * Encrypt a response body under the request's AES key with a bit-flipped IV
   * (Meta's required scheme). Returns raw base64 text for the HTTP response.
   */
  encryptResponse(response: Record<string, unknown>, aesKey: Buffer, iv: Buffer): string {
    const flippedIv = Buffer.from(iv.map((b) => b ^ 0xff));
    const cipher = createCipheriv(`aes-${aesKey.length * 8}-gcm`, aesKey, flippedIv) as CipherGCM;
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(response), 'utf-8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return encrypted.toString('base64');
  }

  private loadPrivateKey(): KeyObject {
    if (this.privateKeyCache) return this.privateKeyCache;
    const pem = this.config.get<string>('WHATSAPP_FLOW_PRIVATE_KEY');
    if (!pem) throw new FlowDecryptError('WHATSAPP_FLOW_PRIVATE_KEY not set');
    // Allow \n-escaped keys stored on a single env line.
    const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
    const passphrase = this.config.get<string>('WHATSAPP_FLOW_KEY_PASSPHRASE') || undefined;
    try {
      this.privateKeyCache = createPrivateKey({ key: normalized, passphrase });
    } catch (err) {
      throw new FlowDecryptError(`failed to load private key: ${(err as Error).message}`);
    }
    return this.privateKeyCache;
  }
}
