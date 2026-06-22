import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

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
  ],
})
export class DBModule {}
