import {Update, Start, Help, On, Hears, Ctx, Command, Action} from 'nestjs-telegraf';
import {Context} from 'telegraf';
import { BotService } from './bot.service';

@Update()
export class BotUpdate {
  constructor(private readonly botService: BotService) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const username = ctx.from?.first_name || 'пользователь';
    const message = this.botService.getWelcomeMessage(username);
    await ctx.reply(message);
    await this.botService.botMenu(ctx);
  }

  @Command('menu')
  async onShowMenu(@Ctx() ctx: Context) {
    await this.botService.showMenu(ctx);
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await ctx.reply('Доступные команды: /start, /help. Или просто отправьте текст.');
  }

  @Hears('id')
  async onSecretWord(@Ctx() ctx: Context) {
    await ctx.reply(`Ваш Telegram ID: ${ctx.from?.id}`);
  }

  @Action('buy')
  async onBuy(@Ctx() ctx: Context) {
    await ctx.answerCbQuery('Гоните монетку', { show_alert: true });
    await ctx.reply('Вы выбрали покупку.');

    await ctx.replyWithInvoice({
      title: 'Подписка на бота',
      description: 'Доступ к расширенным функциям на 1 месяц',
      payload: 'month_subscription_payload',
      provider_token: process.env.TG_PAYMENT_TOKEN!,
      currency: 'RUB',
      prices: [
        { label: 'Основной тариф', amount: 29900 },
      ],
      start_parameter: 'get-subscription',
    });
  }

  @Action('get_link')
  async onGetLink(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    await ctx.reply('Вот ваша ссылка.');
  }

  @Action('get_qr')
  async onGetQR(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    await ctx.reply('Вот ваш QR-код.');
  }

  @On('pre_checkout_query')
  async onPreCheckoutQuery(@Ctx() ctx: Context) {
    await this.botService.handlePreCheckoutQuery(ctx);
  }

  @On('successful_payment')
  async onSuccessfulPayment(@Ctx() ctx: Context) {
    if (ctx.message && 'successful_payment' in ctx.message) {
      const payment = ctx.message.successful_payment;
      const payload = payment.invoice_payload;
      const telegramUserId = ctx.from?.id;

      if (telegramUserId) {
        await this.botService.handleSuccessfulPayment(telegramUserId, payload, ctx);
      }
    }
  }

  @On('text')
  async onMessage(@Ctx() ctx: Context) {
    if (ctx.message && 'text' in ctx.message) {
      const replyText = this.botService.processText(ctx.message.text);
      await ctx.reply(replyText);
    }
  }
}
