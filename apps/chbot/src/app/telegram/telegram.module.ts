import { Module } from '@nestjs/common';
import { TelegrafModule } from "nestjs-telegraf";
import {session} from "telegraf";
import {BotModule} from "./bot/bot.module";

const sessionMiddleWare = session();

// Global anti-spam: 1 request per ACTION_COOLDOWN_MS per user
const spamMap = new Map<number, number>();
const antiSpamMiddleware = (ctx: any, next: any) => {
  const id = ctx.from?.id;
  if (!id) return next();

  const now = Date.now();
  const cooldown = parseInt(process.env.ACTION_COOLDOWN_MS || '1000', 10);
  const last = spamMap.get(id);

  if (last && (now - last) < cooldown) {
    // Silently ignore — answer callback query if present
    if (ctx.callbackQuery) {
      ctx.answerCbQuery().catch(() => {});
    }
    return; // stop processing
  }

  spamMap.set(id, now);
  return next();
};

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      botName: 'chsan0ff_bot',
      useFactory: async () => ({
        token: process.env.TG_API_KEY!,
        middlewares: [
          sessionMiddleWare,
          antiSpamMiddleware,
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
