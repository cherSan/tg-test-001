import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

@Injectable()
export class CommandsService implements OnModuleInit {
  constructor(@InjectBot('chsan0ff_bot') private readonly bot: Telegraf) {}

  async onModuleInit() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.bot.telegram.setMyCommands([
          { command: 'start', description: 'Перезапустить бота' },
          { command: 'menu', description: 'Главное меню' },
          { command: 'help', description: 'Техническая поддержка' },
        ]);
        return;
      } catch (e) {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
