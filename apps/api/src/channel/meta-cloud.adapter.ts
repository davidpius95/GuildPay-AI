import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InboundMessage } from '@guildpay/shared';
import type { ChannelAdapter, OutboundMessage } from './channel-adapter';

/**
 * MetaCloudAdapter — primary WhatsApp transport (Meta Cloud API).
 * Verifies X-Hub-Signature-256, normalizes inbound webhook payloads, and sends
 * text/interactive messages via the Graph API. Secrets come from env.
 */
@Injectable()
export class MetaCloudAdapter implements ChannelAdapter {
  readonly name = 'meta' as const;
  private readonly logger = new Logger(MetaCloudAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get graphVersion(): string {
    return this.config.get<string>('META_GRAPH_VERSION') ?? 'v21.0';
  }

  /** Verify the GET webhook subscription challenge. */
  verifyToken(token: string | undefined): boolean {
    const expected = this.config.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    return !!expected && !!token && token === expected;
  }

  /**
   * Verify X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret).
   * Constant-time comparison; returns false on any malformed input.
   */
  verifySignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
    const appSecret = this.config.get<string>('META_APP_SECRET');
    if (!appSecret || !rawBody || !header?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const received = header.slice('sha256='.length);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(received, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Normalize a Meta webhook payload into InboundMessages (ignores status events). */
  parseInbound(payload: unknown): InboundMessage[] {
    const body = payload as MetaWebhookBody;
    const out: InboundMessage[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        for (const m of value?.messages ?? []) {
          out.push({
            channel: 'meta',
            messageId: m.id,
            waPhone: m.from,
            type: this.mapType(m.type),
            text: m.text?.body ?? m.button?.text,
            mediaId: m.image?.id ?? m.audio?.id ?? m.document?.id,
            mediaMimeType: m.image?.mime_type ?? m.audio?.mime_type ?? m.document?.mime_type,
            interactiveReplyId:
              m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id,
            timestamp: m.timestamp ?? String(Date.now()),
            raw: m,
          });
        }
      }
    }
    return out;
  }

  private mapType(t: string | undefined): InboundMessage['type'] {
    switch (t) {
      case 'audio':
        return 'audio';
      case 'image':
        return 'image';
      case 'document':
        return 'document';
      case 'interactive':
      case 'button':
        return 'interactive';
      default:
        return 'text';
    }
  }

  /**
   * Show the "typing…" indicator (and mark the message read) while we compose a
   * reply. Lasts up to 25s or until the next message is sent. Best-effort.
   */
  async showTyping(messageId: string): Promise<void> {
    const token = this.config.get<string>('META_WHATSAPP_TOKEN');
    const phoneNumberId = this.config.get<string>('META_PHONE_NUMBER_ID');
    if (!token || !phoneNumberId) return;
    const url = `https://graph.facebook.com/${this.graphVersion}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
    });
    if (!res.ok) {
      this.logger.warn(`typing indicator failed (${res.status}): ${await res.text()}`);
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    const token = this.config.get<string>('META_WHATSAPP_TOKEN');
    const phoneNumberId = this.config.get<string>('META_PHONE_NUMBER_ID');
    if (!token || !phoneNumberId) {
      this.logger.error('META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID not set — cannot send');
      return;
    }
    const url = `https://graph.facebook.com/${this.graphVersion}/${phoneNumberId}/messages`;
    const body = this.buildBody(message);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      this.logger.error(`Meta send failed (${res.status}): ${detail}`);
    }
  }

  /**
   * Download a media file from WhatsApp given its media ID.
   * Returns the binary buffer and its mime type.
   */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const token = this.config.get<string>('META_WHATSAPP_TOKEN');
    if (!token) throw new Error('META_WHATSAPP_TOKEN not set');

    // 1. Get the media URL from the Graph API
    const metadataUrl = `https://graph.facebook.com/${this.graphVersion}/${mediaId}`;
    const metaRes = await fetch(metadataUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) {
      throw new Error(`Failed to fetch media metadata: ${await metaRes.text()}`);
    }
    const metadata = (await metaRes.json()) as { url: string; mime_type: string };

    // 2. Download the actual binary data from the returned URL
    const mediaRes = await fetch(metadata.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!mediaRes.ok) {
      throw new Error(`Failed to download media binary: ${await mediaRes.text()}`);
    }
    
    const arrayBuffer = await mediaRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: metadata.mime_type,
    };
  }

  private buildBody(message: OutboundMessage): Record<string, unknown> {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to };
    if (message.kind === 'interactive') {
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: message.body },
          action: {
            buttons: message.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    }
    return { ...base, type: 'text', text: { preview_url: false, body: message.body } };
  }
}

// Minimal shape of the Meta webhook payload we read.
interface MetaWebhookBody {
  entry?: {
    changes?: {
      value?: {
        messages?: MetaMessage[];
      };
    }[];
  }[];
}
interface MetaMessage {
  id?: string;
  from: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  image?: { id?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}
