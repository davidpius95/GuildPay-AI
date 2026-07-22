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
  ONBOARDING_FLOW_TOKEN_PREFIX,
  PIN_SCREEN,
  WhatsappFlowService,
  type FlowEnvelope,
  type FlowRequest,
} from '../channel/whatsapp-flow.service';
import type { FlowScreenResponse } from '../onboarding/onboarding.service';
import { MessageRouter } from '../banking/message-router.service';
import { OnboardingService } from '../onboarding/onboarding.service';

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
    private readonly onboarding: OnboardingService,
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

    // Every non-ping exchange carries a signed flow token; reject a tampered one.
    const tokenData = this.flows.verifyFlowToken(request.flow_token);
    if (!tokenData) {
      // 427 → invalid/expired flow token; the client shows an error + closes.
      throw new HttpException('invalid flow token', 427);
    }

    // Multi-screen onboarding Flow — delegate screen navigation to onboarding.
    if (tokenData.startsWith(ONBOARDING_FLOW_TOKEN_PREFIX)) {
      const userId = tokenData.slice(ONBOARDING_FLOW_TOKEN_PREFIX.length);
      const res = await this.onboarding.handleFlowExchange(
        userId,
        request.action,
        request.screen,
        request.data ?? {},
      );
      return this.withVersionAndToken(version, request.flow_token, res);
    }

    // Opening the single-screen PIN flow → show the PIN screen.
    if (request.action === 'INIT' || request.action === 'BACK') {
      return { version, screen: PIN_SCREEN, data: {} };
    }

    // PIN submitted → run the existing PIN money-gate or first-time PIN setup.
    if (request.action === 'data_exchange' && request.screen === PIN_SCREEN) {
      const pin = typeof request.data?.['pin'] === 'string' ? (request.data['pin'] as string) : '';

      let result: string;
      let message: string;

      if (tokenData.startsWith('onboard_')) {
        const userId = tokenData.replace('onboard_', '');
        result = await this.onboarding.submitPinFlow(userId, pin);
        if (result === 'invalid') {
          message = 'PIN must be exactly 4 digits. Please try again in the chat.';
        } else if (result === 'stale') {
          message = 'You have already set up your PIN. Please continue in the chat.';
        } else {
          message = 'PIN saved securely! Please check your chat to continue setup.';
        }
      } else {
        const txnId = tokenData; // If not onboarding, the token is the txnId.
        result = await this.router.submitPinForTxn(txnId, pin);
        message =
          result === 'dispatched'
            ? 'Processing your transfer — check your WhatsApp chat for the confirmation.'
            : 'This transfer is no longer pending. Please start again in the chat.';
      }

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

  /**
   * Finalize an onboarding screen response: add the protocol `version` and, on a
   * terminal SUCCESS screen, inject the `flow_token` into the closing params (Meta
   * echoes it back so the client can correlate the result).
   */
  private withVersionAndToken(
    version: string,
    flowToken: string | undefined,
    res: FlowScreenResponse,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = res.data ? { ...res.data } : {};
    const emr = data['extension_message_response'] as
      | { params?: Record<string, unknown> }
      | undefined;
    if (emr?.params) {
      emr.params = { flow_token: flowToken, ...emr.params };
    }
    return { version, screen: res.screen, data };
  }
}
