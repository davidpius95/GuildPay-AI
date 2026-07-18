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

export interface OutboundImage {
  to: string;
  kind: 'image';
  image: Buffer;
  mimeType?: string; // defaults to image/png
  caption?: string;
}

/**
 * A WhatsApp Flow message — opens a native modal (data-exchange endpoint Flow).
 * Used for secure PIN entry: the PIN is collected inside the modal and returned
 * to our encrypted Flow endpoint, never appearing in the chat thread.
 */
export interface OutboundFlow {
  to: string;
  kind: 'flow';
  body: string; // message text shown above the flow button
  flowId: string; // WhatsApp Flow ID from Meta (WHATSAPP_PIN_FLOW_ID)
  flowToken: string; // signed token binding the response to a pending txn
  screenId: string; // first screen to open, e.g. 'PIN_SCREEN'
  buttonTitle: string; // CTA label, e.g. 'Verify Transaction'
  mode?: 'draft' | 'published'; // draft lets you test before publishing
}

export type OutboundMessage = OutboundText | OutboundInteractive | OutboundImage | OutboundFlow;

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
