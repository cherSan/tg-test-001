import {Update, Start, Help, On, Hears, Ctx, Command, Action, Settings} from 'nestjs-telegraf';
import {Context} from 'telegraf';
import { BotService } from './bot.service';
import {QrCodeService} from "../../qr/qr.service";
import {UserService} from "../../db/user.service";
import {WIZARD_SCENE_ID} from "./test.wizzard";
import {RND_SCENE_ID} from "./test.scene";

interface SessionData {
  user?: {
    id: number;
    telegramId: number;
    firstName: string;
    username: string | null;
    authToken: string;
  };
}

@Update()
export class BotUpdate {
  constructor(
    private readonly botService: BotService,
    private readonly qr: QrCodeService,
    private readonly userService: UserService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const tgUser = ctx.from;
    if (!tgUser) {
      await ctx.reply('Не удалось получить данные пользователя Telegram.');
      return;
    }

    // Find or create user in database
    const { user, created } = await this.userService.findOrCreate({
      id: tgUser.id,
      first_name: tgUser.first_name,
      last_name: tgUser.last_name,
      username: tgUser.username,
      language_code: tgUser.language_code,
      is_premium: tgUser.is_premium,
    });

    const status = created ? '✅ Вы зарегистрированы в системе.' : '👋 С возвращением!';
    const username = user.firstName || tgUser.first_name || 'пользователь';
    const message = this.botService.getWelcomeMessage(username);

    await ctx.reply(`${message} ${status}`);
    await this.botService.botMenu(ctx);
  }

  @Command('menu')
  async menu(@Ctx() ctx: Context & { session: SessionData }) {
    await this.botService.showMenu(ctx);
  }

  @Help()
  async help(@Ctx() ctx: Context) {
    await ctx.reply('Доступные команды: /start, /help. Или просто отправьте текст.');
  }

  @Settings()
  async settings(@Ctx() ctx: Context) {
    await ctx.reply('Доступные команды: /start, /help. Или просто отправьте текст.');
  }

  @Hears('whoami')
  async onWhoAmI(@Ctx() ctx: Context & { session: SessionData }) {
    const sessionUser = ctx.session?.user;

    if (!sessionUser) {
      await ctx.reply('❌ Вы не авторизованы. Отправьте /start для регистрации.');
      return;
    }

    const dbUser = await this.userService.findByTelegramId(sessionUser.telegramId);

    await ctx.reply(
      `📋 *Ваш профиль*\n` +
        `ID: ${dbUser?.id}\n` +
        `Telegram ID: ${dbUser?.telegramId}\n` +
        `Имя: ${dbUser?.firstName || '—'}\n` +
        `Username: ${dbUser?.username ? '@' + dbUser.username : '—'}\n` +
        `Premium: ${dbUser?.isPremium ? '✅' : '❌'}\n` +
        `Язык: ${dbUser?.languageCode || '—'}\n` +
        `Создан: ${dbUser?.createdAt?.toISOString() || '—'}\n` +
        `\n🔑 Auth token: \`${dbUser?.authToken?.slice(0, 16)}...\``,
      { parse_mode: 'Markdown' },
    );
  }

  @Hears('id')
  async onSecretWord(@Ctx() ctx: Context) {
    await ctx.reply(`Ваш Telegram ID: ${ctx.from?.id}`);
  }

  @Hears('what?')
  async onWhat(@Ctx() ctx: Context) {
    try {
      const data = await fetch('http://127.0.0.1:13544/api/ui-traffic-stats', {
        method: 'GET',
        headers: {
        },
      });
      const d = await data.json();
      console.log(d);
      await ctx.reply('Вы выбрали покупку.');
    } catch(_) {
      await ctx.reply('Something wrong!.');
    }
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
    const qr = await this.qr.generateQrBuffer('HELLO, TEST CONNECTION');
    await ctx.reply(
      'Вот ваш QR-код.',
    );
    await ctx.sendPhoto({ source: qr });
  }

  @Action('wizard_test')
  async wizardTest(@Ctx() ctx: Context): Promise<void> {
    await (ctx as any).scene.enter(WIZARD_SCENE_ID);
  }

  @Action('scene_test')
  async sceneTest(@Ctx() ctx: Context): Promise<void> {
    await (ctx as any).scene.enter(RND_SCENE_ID);
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
  async onMessage(@Ctx() ctx: Context & { session: SessionData }) {
    if (ctx.message && 'text' in ctx.message) {
      const replyText = this.botService.processText(ctx.message.text);
      await ctx.reply(replyText);
    }
  }

  /** Admin-only: list all users */
  @Command('seeusers')
  async onSeeUsers(@Ctx() ctx: Context) {
    const tgUser = ctx.from;
    if (!tgUser) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }

    if (!this.userService.isAdmin(tgUser.id)) {
      await ctx.reply('⛔ Эта команда доступна только администраторам.');
      return;
    }

    const users = await this.userService.findAll();

    if (users.length === 0) {
      await ctx.reply('📭 В базе пока нет пользователей.');
      return;
    }

    const lines = users.map((u, i) => {
      const role = u.role === 'admin' ? '👑' : '👤';
      const name = u.firstName || '—';
      const username = u.username ? `@${u.username}` : '—';
      const lang = u.languageCode || '—';
      const premium = u.isPremium ? '⭐' : '';
      const created = u.createdAt?.toISOString().replace('T', ' ').slice(0, 19) || '—';
      return `${i + 1}. ${role}${premium} **${name}** (${username})\n   ID: \`${u.telegramId}\` | ${lang} | ${created}`;
    });

    const message = `📋 **Список пользователей** (${users.length}):\n\n${lines.join('\n\n')}`;
    await ctx.reply(message, { parse_mode: 'Markdown' });
  }
}
