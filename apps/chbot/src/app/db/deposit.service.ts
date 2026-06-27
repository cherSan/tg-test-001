import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Deposit } from './entities/deposit.entity';
import { UserService } from './user.service';

@Injectable()
export class DepositService {
  constructor(
    @InjectRepository(Deposit)
    private readonly depositRepo: Repository<Deposit>,
    private readonly userService: UserService,
  ) {}

  async create(data: {
    userId: number;
    txId: string;
    currency: string;
    amount: number;
    verifiedAmount?: number;
    status?: string;
  }): Promise<Deposit> {
    const deposit = this.depositRepo.create(data);
    return this.depositRepo.save(deposit);
  }

  async findByTxId(txId: string): Promise<Deposit | null> {
    return this.depositRepo.findOne({ where: { txId } });
  }

  async findPending(): Promise<Deposit[]> {
    return this.depositRepo.find({
      where: { status: 'pending' },
      order: { createdAt: 'DESC' },
    });
  }

  async findByUserId(userId: number): Promise<Deposit[]> {
    return this.depositRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
  }

  async confirm(id: number, verifiedAmount?: number): Promise<Deposit> {
    const deposit = await this.depositRepo.findOne({ where: { id } });
    if (!deposit) throw new Error('Deposit not found');

    deposit.status = 'confirmed';
    if (verifiedAmount !== undefined) {
      deposit.verifiedAmount = verifiedAmount;
    }

    return this.depositRepo.save(deposit);
  }

  async reject(id: number, note?: string): Promise<Deposit> {
    const deposit = await this.depositRepo.findOne({ where: { id } });
    if (!deposit) throw new Error('Deposit not found');

    deposit.status = 'rejected';
    if (note) deposit.adminNote = note;
    return this.depositRepo.save(deposit);
  }
}
