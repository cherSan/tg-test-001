import { Injectable } from '@nestjs/common';
import {Context, Markup} from "telegraf";

@Injectable()
export class BotService {
  getWelcomeMessage(username: string): string {
    return `Привет, ${username}! Рад приветствовать тебя!.`;
  }

  processText(text: string): string {
    return `Вы написали: "${text}". Я получил ваше сообщение.`;
  }

  async showMenu(ctx: Context) {
    await ctx.reply(
      'Main menu:',
      Markup.inlineKeyboard([
        [
          Markup.button.url('Читать правила', 'https://telegram.org'),
        ],
        [
          Markup.button.callback('Купить', 'buy'),
        ],
        [
          Markup.button.callback('Получить ссылку', 'get_link'),
        ],
        [
          Markup.button.callback('Получить QR', 'get_qr'),
        ],
        [
          Markup.button.callback('Show menu', 'show_menu'),
        ],
      ])
    );
  }

  async botMenu(ctx: Context) {
    await ctx.reply(
      'I activate personal commands for you.',
      Markup.keyboard([
        [
          '/start',
          '/menu',
        ],
        [
          '/help',
          '/settings'
        ],
      ]).resize()
        .persistent()
    );
  }

  async handlePreCheckoutQuery(ctx: Context) {
    // В будущем здесь можно добавить логику проверки (наличие товара, актуальность цены и т.д.)
    // Если всё хорошо — подтверждаем (true). Если есть ошибка — передаем false и текст ошибки.
    await ctx.answerPreCheckoutQuery(true);
  }

  async handleSuccessfulPayment(userId: number, payload: string, ctx: Context) {
    console.log(`Пользователь ${userId} успешно оплатил заказ! Payload: ${payload}`);
    // Начисляем подписку / выдаем товар в вашей БД...
    // await this.userService.activateSubscription(userId);

    await ctx.reply('🎉 Спасибо за оплату! Ваша подписка успешно активирована.');
  }
}
