import type { InboundMessage } from '@guildpay/shared';

/** Outbound message primitives the gateway can send back to WhatsApp. */
export interface OutboundText {
  to: string;
  kind: 'text';
  body: string;
}

export interface OutboundInteractive {
  to: string;
  kind: 'interactive';
  body: string;
  buttons: { id: string; title: string }[];
}

export type OutboundMessage = OutboundText | OutboundInteractive;

/**
 * ChannelAdapter — abstracts the WhatsApp transport so the app is agnostic to
 * Meta Cloud API (primary) vs Twilio Sandbox (fallback). Selected by env
 * CHANNEL_ADAPTER. Real webhook parsing + sending land in Week 1.
 */
export interface ChannelAdapter {
  readonly name: 'meta' | 'twilio';
  /** Parse a provider webhook payload into normalized InboundMessages. */
  parseInbound(payload: unknown): InboundMessage[];
  /** Send an outbound message. */
  send(message: OutboundMessage): Promise<void>;
}
