import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from './database.constants';

/** Every sensitive action writes an audit_events row (CLAUDE.md guardrail). */
@Injectable()
export class AuditRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(params: {
    userId?: string | null;
    actor?: 'user' | 'system' | 'admin';
    action: string;
    entity?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `insert into public.audit_events (user_id, actor, action, entity, entity_id, metadata)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        params.userId ?? null,
        params.actor ?? 'system',
        params.action,
        params.entity ?? null,
        params.entityId ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ],
    );
  }
}
