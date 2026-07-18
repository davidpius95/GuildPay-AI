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

/**
 * A WhatsApp List message — a tappable menu that opens a sheet of grouped rows
 * (up to 10 sections × 10 rows). Used where reply buttons (max 3) aren't enough,
 * e.g. the main action menu. Row `id`s are delivered back as `interactiveReplyId`,
 * exactly like button replies, so routing is shared.
 */
export interface OutboundList {
  to: string;
  kind: 'list';
  body: string;
  buttonTitle: string; // label on the button that opens the list, e.g. 'Menu'
  sections: {
    title: string;
    rows: { id: string; title: string; description?: string }[];
  }[];
  header?: string;
  footer?: string;
}

export type OutboundMessage =
  | OutboundText
  | OutboundInteractive
  | OutboundImage
  | OutboundFlow
  | OutboundList;

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
