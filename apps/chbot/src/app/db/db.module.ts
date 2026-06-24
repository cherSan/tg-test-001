import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Deposit } from './entities/deposit.entity';
import { VpnKey } from './entities/vpn-key.entity';
import { Ticket } from './entities/ticket.entity';
import { UserService } from './user.service';
import { DepositService } from './deposit.service';
import { VpnKeyService } from './vpn-key.service';
import { TicketService } from './ticket.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'sqljs',
        location: process.env.DB_PATH || 'data/chbot.db',
        autoSave: true,
        autoLoadEntities: true,
        synchronize: true, // TODO: disable in production
      }),
    }),
    TypeOrmModule.forFeature([User, Deposit, VpnKey, Ticket]),
  ],
  providers: [UserService, DepositService, VpnKeyService, TicketService],
  exports: [TypeOrmModule, UserService, DepositService, VpnKeyService, TicketService],
})
export class DBModule {}
