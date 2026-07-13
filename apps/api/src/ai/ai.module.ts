import { Module } from '@nestjs/common';
import { AiService } from './ai.service';

/**
 * AiModule — provides the AiService (multi-provider fallback orchestrator)
 * to any module that needs LLM chat completions.
 *
 * Requires ConfigModule to be global (set in AppModule).
 */
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
