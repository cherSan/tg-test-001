import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export interface TicketReply {
  userId: number;
  userName: string;
  message: string;
  createdAt: string;
}

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  userId!: number;

  @Column({ type: 'varchar', length: 256 })
  topic!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: string; // 'open' | 'closed'

  /** JSON array of TicketReply */
  @Column({ type: 'text', default: '[]' })
  replies!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
