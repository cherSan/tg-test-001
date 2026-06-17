import { Module } from '@nestjs/common';
import { TelegrafModule } from "nestjs-telegraf";
import { HttpsProxyAgent } from 'https-proxy-agent';
import {BotUpdate} from "./bot.update";
import {BotService} from "./bot.service";

const agent = process.env.TG_PROXY ? new HttpsProxyAgent(process.env.TG_PROXY) : undefined;

@Module({
  imports: [
    TelegrafModule.forRoot({
      token: process.env.TG_API_KEY!,
      launchOptions: {
        dropPendingUpdates: true,
      },
      options: {
        handlerTimeout: 1000,
        telegram: {
          apiRoot: process.env.TG_API_ROOT || undefined,
          agent,
        },
      },
    }),
  ],
  providers: [BotUpdate, BotService],
})
export class AppModule {}
