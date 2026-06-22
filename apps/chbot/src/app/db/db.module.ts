import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Deposit } from './entities/deposit.entity';
import { UserService } from './user.service';
import { DepositService } from './deposit.service';

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
    TypeOrmModule.forFeature([User, Deposit]),
  ],
  providers: [UserService, DepositService],
  exports: [TypeOrmModule, UserService, DepositService],
})
export class DBModule {}
