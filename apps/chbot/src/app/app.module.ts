import { Module } from '@nestjs/common';
import { QrModule } from "./qr/qr.module";
import { TelegramModule } from "./telegram/telegram.module";

@Module({
  imports: [
    QrModule,
    TelegramModule,
  ],
  providers: [],
})
export class AppModule {}
