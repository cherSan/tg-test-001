import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserService } from './user.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'better-sqlite3',
        database: process.env.DB_PATH || 'data/chbot.db',
        autoLoadEntities: true,
        synchronize: true, // TODO: disable in production
      }),
    }),
    TypeOrmModule.forFeature([User]),
  ],
  providers: [UserService],
  exports: [TypeOrmModule, UserService],
})
export class DBModule {}
