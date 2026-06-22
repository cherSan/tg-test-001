import { Module } from '@nestjs/common';
import { QrModule } from "./qr/qr.module";
import { TelegramModule } from "./telegram/telegram.module";
import { DBModule } from './db/db.module';

@Module({
  imports: [QrModule, TelegramModule, DBModule,],
  providers: [],
})
export class AppModule {}
