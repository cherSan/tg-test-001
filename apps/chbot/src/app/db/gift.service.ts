import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GiftCode } from './entities/gift-code.entity';
import * as crypto from 'crypto';

@Injectable()
export class GiftService {
  constructor(
    @InjectRepository(GiftCode)
    private readonly repo: Repository<GiftCode>,
  ) {}

  private generateCode(): string {
    return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
  }

  async create(fromUserId: number, planHours: number): Promise<GiftCode> {
    const code = this.generateCode();
    const gift = this.repo.create({ code, fromUserId, planHours, status: 'active' });
    return this.repo.save(gift);
  }

  async findByCode(code: string): Promise<GiftCode | null> {
    return this.repo.findOne({ where: { code: code.toUpperCase() } });
  }

  async findByFromUserId(userId: number): Promise<GiftCode[]> {
    return this.repo.find({ where: { fromUserId: userId }, order: { createdAt: 'DESC' } });
  }

  async redeem(code: string, redeemedBy: number): Promise<GiftCode | null> {
    const gift = await this.findByCode(code);
    if (!gift || gift.status !== 'active') return null;

    // Check expiry (30 days default)
    const validityDays = parseInt(process.env.GIFT_CODE_VALIDITY_DAYS || '30', 10);
    if (Date.now() - new Date(gift.createdAt).getTime() > validityDays * 86400_000) {
      gift.status = 'expired';
      await this.repo.save(gift);
      return null;
    }

    gift.status = 'redeemed';
    gift.redeemedBy = redeemedBy;
    gift.redeemedAt = new Date();
    return this.repo.save(gift);
  }
}
