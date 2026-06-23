import { Module } from '@nestjs/common';
import { TelegrafModule } from "nestjs-telegraf";
import {session} from "telegraf";
import {BotModule} from "./bot/bot.module";

const sessionMiddleWare = session();

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      botName: 'chsan0ff_bot',
      useFactory: async () => ({
        token: process.env.TG_API_KEY!,
        middlewares: [
          sessionMiddleWare,
          (ctx, next) => {
            // console.log(`[${new Date().toLocaleString()}][Telegraf Update ID: ${ctx.update.update_id}] Тип: ${ctx.updateType}`);
            // console.log(`[${new Date().toLocaleString()}][Telegraf message: ${JSON.stringify(ctx)}]`);
            return next();
          },
        ],
        launchOptions: {
          dropPendingUpdates: true,
        },
        options: {
          handlerTimeout: 90_000,
          telegram: {
            apiRoot: process.env.TG_API_ROOT || undefined,
          },
        },
        include: [BotModule],
      }),
    }),
    BotModule,
  ],
})
export class TelegramModule {}
