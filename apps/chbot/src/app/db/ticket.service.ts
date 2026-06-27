import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ticket, TicketReply } from './entities/ticket.entity';

@Injectable()
export class TicketService {
  constructor(
    @InjectRepository(Ticket)
    private readonly repo: Repository<Ticket>,
  ) {}

  async create(data: { userId: number; topic: string; message: string }): Promise<Ticket> {
    const ticket = this.repo.create(data);
    return this.repo.save(ticket);
  }

  async findById(id: number): Promise<Ticket | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByUserId(userId: number): Promise<Ticket[]> {
    return this.repo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
  }

  async findOpen(): Promise<Ticket[]> {
    return this.repo.find({
      where: { status: 'open' },
      order: { createdAt: 'ASC' },
    });
  }

  async countOpenByUserId(userId: number): Promise<number> {
    return this.repo.count({ where: { userId, status: 'open' } });
  }

  async findAll(): Promise<Ticket[]> {
    return this.repo.find({ order: { createdAt: 'DESC' }, take: 50 });
  }

  /** Check if user created a ticket within cooldownMinutes */
  async hasRecentTicket(userId: number, cooldownMinutes: number): Promise<boolean> {
    const recent = await this.repo.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    if (!recent) return false;
    return (Date.now() - new Date(recent.createdAt).getTime()) < cooldownMinutes * 60_000;
  }

  async addReply(ticketId: number, reply: TicketReply): Promise<Ticket | null> {
    const ticket = await this.findById(ticketId);
    if (!ticket) return null;

    const replies: TicketReply[] = JSON.parse(ticket.replies || '[]');
    replies.push(reply);
    ticket.replies = JSON.stringify(replies);
    return this.repo.save(ticket);
  }

  async close(id: number): Promise<Ticket | null> {
    const ticket = await this.findById(id);
    if (!ticket) return null;
    ticket.status = 'closed';
    return this.repo.save(ticket);
  }
}
