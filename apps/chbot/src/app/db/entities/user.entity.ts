import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Telegram user ID */
  @Column({ type: 'bigint', unique: true })
  telegramId!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  firstName?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  lastName?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: false })
  username!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  languageCode?: string | null;

  @Column({ type: 'boolean', default: false })
  isPremium?: boolean;

  @Column({ type: 'varchar', length: 512, nullable: true })
  photoUrl?: string | null;

  /** Auth token for future Passport-based authorization */
  @Column({ type: 'varchar', length: 64, nullable: true })
  authToken?: string | null;

  /** User role: 'user' or 'admin' */
  @Column({ type: 'varchar', length: 16, default: 'user' })
  role!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
