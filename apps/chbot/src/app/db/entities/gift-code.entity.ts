import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type GiftStatus = 'active' | 'redeemed' | 'expired';

@Entity('gift_codes')
export class GiftCode {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 8, unique: true })
  code!: string;

  @Column({ type: 'integer' })
  fromUserId!: number;

  @Column({ type: 'integer' })
  planHours!: number;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: GiftStatus;

  @Column({ type: 'integer', nullable: true })
  redeemedBy?: number | null;

  @Column({ type: 'datetime', nullable: true })
  redeemedAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
