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

  /** How many times an action has been recorded for an entity (e.g. pin_failed per txn). */
  async countByEntityAction(entityId: string, action: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'select count(*)::text as n from public.audit_events where entity_id = $1 and action = $2',
      [entityId, action],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
