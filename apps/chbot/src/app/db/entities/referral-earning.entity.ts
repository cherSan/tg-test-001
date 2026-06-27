import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('referral_earnings')
export class ReferralEarning {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Telegram ID of referrer who earned this */
  @Column({ type: 'bigint' })
  referrerId!: number;

  /** Telegram ID of referral who triggered this */
  @Column({ type: 'bigint' })
  referralId!: number;

  @Column({ type: 'real' })
  amount!: number;

  /** usdt or days */
  @Column({ type: 'varchar', length: 8 })
  type!: string;

  /** Referrer's level at the time of earning */
  @Column({ type: 'integer', default: 1 })
  level!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
