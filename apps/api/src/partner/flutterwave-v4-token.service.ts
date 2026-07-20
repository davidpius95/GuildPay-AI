import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_TOKEN_URL =
  'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
/** Refresh this many ms before the token's stated expiry, to avoid edge-of-expiry 401s. */
const REFRESH_SKEW_MS = 60_000;
/** Fallback lifetime if the token endpoint omits expires_in (v4 tokens are ~10 min). */
const DEFAULT_TTL_SECONDS = 600;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * OAuth2 client-credentials token manager for the Flutterwave v4 Wallets API.
 * v4 issues short-lived (~10 min) bearer tokens from an identity provider, unlike
 * the static v3 secret key. This caches the token, refreshes it ~1 min before it
 * expires, and single-flights concurrent requests so a burst of virtual-account
 * creations never stampedes the token endpoint. Secrets and tokens are never logged.
 */
@Injectable()
export class FlutterwaveV4TokenService {
  private readonly logger = new Logger(FlutterwaveV4TokenService.name);
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** A valid bearer token, from cache when fresh, otherwise fetched (deduped). */
  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - REFRESH_SKEW_MS) {
      return this.cached.token;
    }
    // Single-flight: concurrent callers share one in-flight fetch.
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const clientId = this.config.get<string>('FLW_V4_CLIENT_ID');
    const clientSecret = this.config.get<string>('FLW_V4_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new Error('FLW_V4_CLIENT_ID / FLW_V4_CLIENT_SECRET are not set');
    }
    const url = this.config.get<string>('FLW_V4_TOKEN_URL') ?? DEFAULT_TOKEN_URL;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      // Never log the client secret; surface only the provider's error label.
      this.logger.warn(`FLW v4 token request -> ${res.status} ${json.error ?? ''}`);
      throw new Error(`FLW v4 token request failed: ${json.error_description ?? json.error ?? res.statusText}`);
    }

    const ttl = (json.expires_in ?? DEFAULT_TTL_SECONDS) * 1000;
    this.cached = { token: json.access_token, expiresAt: Date.now() + ttl };
    return json.access_token;
  }
}
