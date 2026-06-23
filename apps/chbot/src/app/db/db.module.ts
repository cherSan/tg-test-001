import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Deposit } from './entities/deposit.entity';
import { VpnKey } from './entities/vpn-key.entity';
import { UserService } from './user.service';
import { DepositService } from './deposit.service';
import { VpnKeyService } from './vpn-key.service';

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
    TypeOrmModule.forFeature([User, Deposit, VpnKey]),
  ],
  providers: [UserService, DepositService, VpnKeyService],
  exports: [TypeOrmModule, UserService, DepositService, VpnKeyService],
})
export class DBModule {}
