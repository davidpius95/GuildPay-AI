import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminService } from './admin.service';
import { OpsService } from './ops.service';
import type { ListPage } from '../partner/partner-adapter';

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
    private readonly ops: OpsService,
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

  @Patch('admin/users/:id')
  @HttpCode(200)
  async updateUser(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-admin-token') token?: string,
  ) {
    this.assertToken(token);
    await this.admin.updateUser(id, body ?? {});
    return { status: 'ok' };
  }

  @Delete('admin/users/:id/beneficiaries/:beneficiaryId')
  @HttpCode(200)
  async deleteBeneficiary(
    @Param('id') id: string,
    @Param('beneficiaryId') beneficiaryId: string,
    @Headers('x-admin-token') token?: string,
  ) {
    this.assertToken(token);
    await this.admin.deleteBeneficiary(id, beneficiaryId);
    return { status: 'ok' };
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

  // ── Merchant operations (Flutterwave) ──────────────────────────────────────

  @Get('admin/balances')
  async balances(@Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    return this.ops.getBalances();
  }

  @Get('admin/settlements')
  async settlements(
    @Query('page') page?: string,
    @Query('status') status?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    this.assertToken(token);
    return this.ops.listSettlements(pageParams(page, status));
  }

  @Get('admin/settlements/:id')
  async settlement(@Param('id') id: string, @Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    return this.ops.getSettlement(id);
  }

  @Get('admin/disputes')
  async disputes(
    @Query('page') page?: string,
    @Query('status') status?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    this.assertToken(token);
    return this.ops.listDisputes(pageParams(page, status));
  }

  @Get('admin/disputes/:id')
  async dispute(@Param('id') id: string, @Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    return this.ops.getDispute(id);
  }

  @Get('admin/banks')
  async banks(@Headers('x-admin-token') token?: string) {
    this.assertToken(token);
    return this.ops.listBanks();
  }

  @Get('admin/name-enquiry')
  async nameEnquiry(
    @Query('account') account?: string,
    @Query('bankCode') bankCode?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    this.assertToken(token);
    if (!account || !bankCode) {
      return { error: 'account and bankCode are required' };
    }
    return this.ops.nameEnquiry(account, bankCode);
  }
}

function pageParams(page?: string, status?: string): ListPage {
  const n = page ? Number(page) : undefined;
  return { page: n && Number.isFinite(n) ? n : undefined, status: status || undefined };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
