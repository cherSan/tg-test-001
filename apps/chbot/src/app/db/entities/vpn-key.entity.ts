import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('vpn_keys')
export class VpnKey {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  userId!: number;

  /** Sequential key index per user (1, 2, 3...) */
  @Column({ type: 'integer' })
  keyIndex!: number;

  /** HideFox VPN client ID */
  @Column({ type: 'varchar', length: 64, unique: true })
  peerId!: string;

  /** Subscription expiry for this specific key */
  @Column({ type: 'datetime', nullable: true })
  subscriptionExpiresAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
