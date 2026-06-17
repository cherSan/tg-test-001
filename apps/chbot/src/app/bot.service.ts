import {Injectable, OnModuleDestroy} from '@nestjs/common';
import {Context, Markup, Telegraf} from "telegraf";
import {InjectBot} from "nestjs-telegraf";

@Injectable()
export class BotService implements OnModuleDestroy {
  constructor(
    @InjectBot() private readonly bot: Telegraf
  ) {
    this.setupManualListeners();
  }

  getWelcomeMessage(username: string): string {
    return `Привет, ${username}! Рад приветствовать тебя в NestJS боте.`;
  }

  processText(text: string): string {
    return `Вы написали: "${text}". Я получил ваше сообщение.`;
  }

  async showMenu(ctx: Context) {
    await ctx.reply(
      'Главное меню:',
      Markup.inlineKeyboard([
        [
          Markup.button.url('Читать правила', 'https://telegram.org'),
        ],
        [
          Markup.button.callback('Купить', 'buy'),
          Markup.button.callback('Получить ссылку', 'get_link'),
        ],
        [
          Markup.button.callback('Получить QR', 'get_qr'),
        ]
      ]),
    );
  }

  async mainCommands(ctx: Context) {
    await ctx.reply(
      'Команды:',
      Markup.keyboard([
        [
          '/menu',
          '/help',
        ],
      ]).resize()
        .persistent()
    );
  }

  async onModuleDestroy() {
    await this.disconnectBot('NestJS Module Destroy');
  }

  private setupManualListeners() {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

    signals.forEach((signal) => {
      process.once(signal, async () => {
        await this.disconnectBot(`Node.js ${signal}`);
        process.exit(0);
      });
    });
  }

  private async disconnectBot(reason: string) {
    console.log(`[Telegram Shutdown] Остановка бота по причине: ${reason}...`);
    try {
      if (this.bot && typeof this.bot.stop === 'function') {
        this.bot.stop();
        console.log('[Telegram Shutdown] Соединение с Telegram успешно закрыто.');
      }
    } catch (error) {
      console.error('[Telegram Shutdown] Ошибка при закрытии бота:', error);
    }
  }
}
