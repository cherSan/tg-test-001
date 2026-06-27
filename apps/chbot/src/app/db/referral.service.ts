import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReferralEarning } from './entities/referral-earning.entity';

@Injectable()
export class ReferralService {
  constructor(
    @InjectRepository(ReferralEarning)
    private readonly repo: Repository<ReferralEarning>,
  ) {}

  async create(data: {
    referrerId: number;
    referralId: number;
    amount: number;
    type: string;
    level: number;
  }): Promise<ReferralEarning> {
    const e = this.repo.create(data);
    return this.repo.save(e);
  }

  async findByReferrer(referrerId: number): Promise<ReferralEarning[]> {
    return this.repo.find({
      where: { referrerId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async getStats(referrerId: number): Promise<{
    totalEarned: number;
    totalReferrals: number;
    activeReferrals: number;
  }> {
    const earnings = await this.findByReferrer(referrerId);
    const totalEarned = earnings
      .filter((e) => e.type === 'usdt')
      .reduce((sum, e) => sum + e.amount, 0);

    const referralIds = new Set(earnings.map((e) => e.referralId));
    const totalReferrals = referralIds.size;

    // Active: has earnings in the list
    const activeReferrals = referralIds.size; // simplified — any referral who triggered an earning

    return { totalEarned, totalReferrals, activeReferrals };
  }

  async getReferralCount(referrerId: number): Promise<number> {
    const earnings = await this.findByReferrer(referrerId);
    return new Set(earnings.map((e) => e.referralId)).size;
  }
}
