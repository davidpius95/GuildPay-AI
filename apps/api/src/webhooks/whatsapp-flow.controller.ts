import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { MetaCloudAdapter } from '../channel/meta-cloud.adapter';
import {
  FLOW_SUCCESS_SCREEN,
  FlowDecryptError,
  PIN_SCREEN,
  WhatsappFlowService,
  type FlowEnvelope,
  type FlowRequest,
} from '../channel/whatsapp-flow.service';
import { MessageRouter } from '../banking/message-router.service';

/**
 * WhatsApp Flow data-exchange endpoint (encrypted).
 *   POST /webhooks/whatsapp/flow
 * Meta posts an RSA+AES-GCM encrypted envelope for each screen exchange. We
 * decrypt, act, and return the response encrypted under the same AES key as raw
 * base64 text. The PIN only ever exists inside this decrypted exchange — it is
 * never placed in the chat thread and never logged.
 */
@Controller('webhooks/whatsapp/flow')
export class WhatsappFlowController {
  private readonly logger = new Logger(WhatsappFlowController.name);

  constructor(
    private readonly meta: MetaCloudAdapter,
    private readonly flows: WhatsappFlowService,
    private readonly router: MessageRouter,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  async handle(@Req() req: RawBodyRequest<Request>, @Body() body: FlowEnvelope): Promise<string> {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!this.meta.verifySignature(req.rawBody, signature)) {
      throw new ForbiddenException('invalid signature');
    }

    let request: FlowRequest;
    let aesKey: Buffer;
    let iv: Buffer;
    try {
      ({ request, aesKey, iv } = this.flows.decryptRequest(body));
    } catch (err) {
      if (err instanceof FlowDecryptError) {
        this.logger.warn(`flow decrypt failed: ${err.message}`);
        // 421 tells Meta the request could not be decrypted (refresh the key).
        throw new HttpException('cannot decrypt', 421);
      }
      throw err;
    }

    const response = await this.route(request);
    return this.flows.encryptResponse(response, aesKey, iv);
  }

  /** Route a decrypted Flow request to a response body (never logs `data`). */
  private async route(request: FlowRequest): Promise<Record<string, unknown>> {
    const version = request.version;

    // Health check ping from Meta.
    if (request.action === 'ping') {
      return { version, data: { status: 'active' } };
    }
    // Client-side error notification.
    if (request.data?.['error'] || request.data?.['error_message']) {
      this.logger.warn('flow client error notification received');
      return { version, data: { acknowledged: true } };
    }

    // Opening the flow → show the PIN screen.
    if (request.action === 'INIT' || request.action === 'BACK') {
      return { version, screen: PIN_SCREEN, data: {} };
    }

    // PIN submitted → verify token → run the existing PIN money-gate.
    if (request.action === 'data_exchange' && request.screen === PIN_SCREEN) {
      const txnId = this.flows.verifyFlowToken(request.flow_token);
      const pin = typeof request.data?.['pin'] === 'string' ? (request.data['pin'] as string) : '';
      if (!txnId) {
        // 427 → invalid/expired flow token; the client shows an error + closes.
        throw new HttpException('invalid flow token', 427);
      }
      const result = await this.router.submitPinForTxn(txnId, pin);
      const message =
        result === 'dispatched'
          ? 'Processing your transfer — check your WhatsApp chat for the confirmation.'
          : 'This transfer is no longer pending. Please start again in the chat.';
      return {
        version,
        screen: FLOW_SUCCESS_SCREEN,
        data: {
          extension_message_response: {
            params: { flow_token: request.flow_token, result, message },
          },
        },
      };
    }

    this.logger.warn(`unhandled flow action/screen: ${request.action}/${request.screen}`);
    throw new HttpException('unsupported flow request', HttpStatus.BAD_REQUEST);
  }
}
