import { z } from 'zod';

/** Normalized inbound message — the internal shape every ChannelAdapter emits. */
export const InboundMessageSchema = z.object({
  channel: z.enum(['meta', 'twilio']),
  waPhone: z.string().min(1), // E.164, e.g. +974XXXXXXXX or +234XXXXXXXXXX
  type: z.enum(['text', 'audio', 'image', 'document', 'interactive']),
  text: z.string().optional(),
  mediaId: z.string().optional(),
  mediaMimeType: z.string().optional(),
  interactiveReplyId: z.string().optional(),
  timestamp: z.string(),
  raw: z.unknown(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
