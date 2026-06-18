import { Module } from '@nestjs/common';
import { TelegramModule } from "./telegram/telegram.module";

@Module({
  imports: [
    TelegramModule,
  ],
  providers: [],
})
export class AppModule {}
