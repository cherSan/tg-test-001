import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import * as crypto from 'crypto';

interface TelegramProfile {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async findByTelegramId(telegramId: number): Promise<User | null> {
    return this.userRepo.findOne({ where: { telegramId } });
  }

  async findById(id: number): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  /** Check if a Telegram ID belongs to an admin (from ADMIN_IDS env var) */
  isAdmin(telegramId: number): boolean {
    const adminIds = this.getAdminIds();
    return adminIds.includes(telegramId);
  }

  /** Get admin Telegram IDs from env */
  private getAdminIds(): number[] {
    const raw = process.env.ADMIN_IDS || '';
    if (!raw.trim()) return [];
    return raw
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));
  }

  async findOrCreate(telegramProfile: TelegramProfile): Promise<{ user: User; created: boolean }> {
    const existing = await this.findByTelegramId(telegramProfile.id);
    if (existing) {
      // Sync admin role based on env (in case admins change)
      const shouldBeAdmin = this.isAdmin(telegramProfile.id);
      if (shouldBeAdmin && existing.role !== 'admin') {
        existing.role = 'admin';
        await this.userRepo.save(existing);
      } else if (!shouldBeAdmin && existing.role === 'admin') {
        existing.role = 'user';
        await this.userRepo.save(existing);
      }
      const updated = await this.updateProfile(existing, telegramProfile);
      return { user: updated, created: false };
    }

    const role = this.isAdmin(telegramProfile.id) ? 'admin' : 'user';

    const user = this.userRepo.create({
      telegramId: telegramProfile.id,
      firstName: telegramProfile.first_name || null,
      lastName: telegramProfile.last_name || null,
      username: telegramProfile.username || null,
      languageCode: telegramProfile.language_code || null,
      isPremium: telegramProfile.is_premium || false,
      photoUrl: telegramProfile.photo_url || null,
      role,
      authToken: this.generateAuthToken(),
      referralCode: this.generateReferralCode(),
    });

    const saved = await this.userRepo.save(user);
    return { user: saved, created: true };
  }

  async update(userId: number, data: Partial<User>): Promise<User> {
    await this.userRepo.update(userId, data);
    return (await this.userRepo.findOne({ where: { id: userId } }))!;
  }

  async delete(userId: number): Promise<void> {
    await this.userRepo.delete(userId);
  }

  /** Add funds to user's balance for a specific currency */
  async creditBalance(userId: number, currency: string, amount: number): Promise<User> {
    const field = currency === 'BTC' ? 'userBalanceBTC' as const
      : currency === 'GRAM' ? 'userBalanceGram' as const
      : 'userBalanceUSDT' as const;
    const user = await this.findById(userId);
    const newAmount = (user?.[field] || 0) + amount;
    return this.update(userId, { [field]: newAmount });
  }

  async findByAuthToken(token: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { authToken: token } });
  }

  /** Get all users — admins first, then by registration date DESC */
  async findAll(): Promise<User[]> {
    return this.userRepo
      .createQueryBuilder('user')
      .orderBy("CASE WHEN user.role = 'admin' THEN 0 ELSE 1 END")
      .addOrderBy('user.createdAt', 'DESC')
      .getMany();
  }

  /** Get users awaiting activation (not active, not blocked) */
  async findPending(): Promise<User[]> {
    return this.userRepo.find({
      where: { userIsActive: false, userIsBlocked: false },
      order: { createdAt: 'DESC' },
    });
  }

  /** Get all admin users */
  async findAllAdmins(): Promise<User[]> {
    return this.userRepo.find({ where: { role: 'admin' } });
  }

  private async updateProfile(user: User, profile: TelegramProfile): Promise<User> {
    let changed = false;

    if (profile.first_name && user.firstName !== profile.first_name) {
      user.firstName = profile.first_name;
      changed = true;
    }
    if (profile.last_name && user.lastName !== profile.last_name) {
      user.lastName = profile.last_name;
      changed = true;
    }
    if (profile.username && user.username !== profile.username) {
      user.username = profile.username;
      changed = true;
    }
    if (profile.language_code && user.languageCode !== profile.language_code) {
      user.languageCode = profile.language_code;
      changed = true;
    }
    if (user.isPremium !== (profile.is_premium || false)) {
      user.isPremium = profile.is_premium || false;
      changed = true;
    }
    if (profile.photo_url && user.photoUrl !== profile.photo_url) {
      user.photoUrl = profile.photo_url;
      changed = true;
    }

    if (changed) {
      return this.userRepo.save(user);
    }
    return user;
  }

  async findByReferralCode(code: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { referralCode: code } });
  }

  async setReferrer(userId: number, referrerId: number): Promise<User> {
    return this.update(userId, { referrerId } as any);
  }

  async getReferrals(referrerId: number): Promise<User[]> {
    return this.userRepo.find({ where: { referrerId } as any });
  }

  private generateAuthToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private generateReferralCode(): string {
    return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
  }
}
