import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VpnKey } from './entities/vpn-key.entity';

@Injectable()
export class VpnKeyService {
  constructor(
    @InjectRepository(VpnKey)
    private readonly repo: Repository<VpnKey>,
  ) {}

  async findByUserId(userId: number): Promise<VpnKey[]> {
    return this.repo.find({
      where: { userId },
      order: { keyIndex: 'ASC' },
    });
  }

  async findById(id: number): Promise<VpnKey | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByPeerId(peerId: string): Promise<VpnKey | null> {
    return this.repo.findOne({ where: { peerId } });
  }

  /** Get next key index for user */
  async getNextIndex(userId: number): Promise<number> {
    const keys = await this.findByUserId(userId);
    if (keys.length === 0) return 1;
    return Math.max(...keys.map((k) => k.keyIndex)) + 1;
  }

  async create(data: {
    userId: number;
    keyIndex: number;
    peerId: string;
    subscriptionExpiresAt: Date;
  }): Promise<VpnKey> {
    const key = this.repo.create(data);
    return this.repo.save(key);
  }

  async update(id: number, data: Partial<VpnKey>): Promise<VpnKey> {
    await this.repo.update(id, data);
    return (await this.repo.findOne({ where: { id } }))!;
  }

  async delete(id: number): Promise<void> {
    await this.repo.delete(id);
  }

  /** Delete all keys for a user */
  async deleteByUserId(userId: number): Promise<void> {
    await this.repo.delete({ userId } as any);
  }
}
