import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminService } from './admin.service';

/**
 * Admin API (/v1/admin, /v1/demo). Publicly routed, so every call requires the
 * x-admin-token header to equal ADMIN_API_TOKEN (constant-time compared). The
 * dashboard calls these server-side with the token from its env.
 */
@Controller('v1')
export class AdminController {
  constructor(
    private readonly config: ConfigService,
    private readonly admin: AdminService,
  ) {}

  private assertToken(token: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_API_TOKEN');
    if (!expected || !token || !constantTimeEqual(token, expected)) {
      throw new UnauthorizedException('invalid admin token');
    }
  }

  @Get('admin/users')
  async users(@Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    return this.admin.listUsers();
  }

  @Post('admin/users/:id/reset')
  @HttpCode(200)
  async reset(@Param('id') id: string, @Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    await this.admin.resetUser(id);
    return { status: 'ok' };
  }

  @Delete('admin/users/:id')
  @HttpCode(200)
  async remove(@Param('id') id: string, @Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    await this.admin.deleteUser(id);
    return { status: 'ok' };
  }

  @Post('demo/reset')
  @HttpCode(200)
  async demoReset(@Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    await this.admin.demoResetAll();
    return { status: 'ok' };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
