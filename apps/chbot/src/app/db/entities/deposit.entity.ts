import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('deposits')
export class Deposit {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  userId!: number;

  /** Transaction hash */
  @Column({ type: 'varchar', length: 128, unique: true })
  txId!: string;

  /** BTC, USDT, or GRAM */
  @Column({ type: 'varchar', length: 8 })
  currency!: string;

  /** User-declared amount */
  @Column({ type: 'real' })
  amount!: number;

  /** Actual verified amount from blockchain */
  @Column({ type: 'real', nullable: true })
  verifiedAmount?: number | null;

  /** pending / confirmed / rejected */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  /** Admin note on rejection */
  @Column({ type: 'varchar', length: 256, nullable: true })
  adminNote?: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
