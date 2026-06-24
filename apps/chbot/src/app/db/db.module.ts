import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Deposit } from './entities/deposit.entity';
import { VpnKey } from './entities/vpn-key.entity';
import { Ticket } from './entities/ticket.entity';
import { ReferralEarning } from './entities/referral-earning.entity';
import { UserService } from './user.service';
import { DepositService } from './deposit.service';
import { VpnKeyService } from './vpn-key.service';
import { TicketService } from './ticket.service';
import { ReferralService } from './referral.service';

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
    TypeOrmModule.forFeature([User, Deposit, VpnKey, Ticket, ReferralEarning]),
  ],
  providers: [UserService, DepositService, VpnKeyService, TicketService, ReferralService],
  exports: [TypeOrmModule, UserService, DepositService, VpnKeyService, TicketService, ReferralService],
})
export class DBModule {}
