import { Injectable } from '@nestjs/common';
import {Context, Markup} from "telegraf";
import { UserService } from '../../db/user.service';
import { User } from '../../db/entities/user.entity';

@Injectable()
export class BotService {
  /** Auto-activate users after CAPTCHA (can be toggled in admin settings) */
  autoActivate: boolean = process.env.AUTO_ACTIVATE === 'true';

  constructor(private readonly userService: UserService) {}

  getWelcomeMessage(username: string): string {
    return `Привет, ${username}! Рад приветствовать тебя!.`;
  }

  processText(text: string): string {
    return `Вы написали: "${text}". Я получил ваше сообщение.`;
  }

  async showMenu(ctx: Context) {
    const tgUser = ctx.from;
    const isAdmin = tgUser ? this.userService.isAdmin(tgUser.id) : false;

    const buttons: any[][] = [
      [
        Markup.button.url('Читать правила', 'https://telegram.org'),
      ],
      [
        Markup.button.callback('Купить', 'buy'),
      ],
      [
        Markup.button.callback('Получить QR', 'get_qr'),
        Markup.button.callback('Получить ссылку', 'get_link'),
      ],
      [
        Markup.button.callback('Тест визарда', 'wizard_test'),
        Markup.button.callback('Тест сцены', 'scene_test'),
      ],
    ];

    if (isAdmin) {
      buttons.push([Markup.button.callback('👥 Пользователи', 'seeusers')]);
      buttons.push([Markup.button.callback('⏳ Ожидают активации', 'pending_users')]);
      buttons.push([Markup.button.callback('📝 Редактировать пользователей', 'edit_users')]);
      buttons.push([Markup.button.callback('⚙️ Настройки', 'admin_settings')]);
    }

    buttons.push([Markup.button.callback('Show menu', 'show_menu')]);

    await ctx.reply('Main menu:', Markup.inlineKeyboard(buttons));
  }

  async botMenu(ctx: Context) {
    const tgUser = ctx.from;
    const isAdmin = tgUser ? this.userService.isAdmin(tgUser.id) : false;

    const buttons: any[][] = [
      ['/start', '/menu'],
      ['/help', '/settings'],
    ];

    if (isAdmin) {
      buttons.push(['/seeusers']);
    }

    await ctx.reply(
      'I activate personal commands for you.',
      Markup.keyboard(buttons).resize().persistent(),
    );
  }

  /** Message shown to users waiting for activation */
  async sendPendingActivationMessage(ctx: Context) {
    await ctx.reply(
      '⏳ Ваш аккаунт ожидает активации администратором.\n' +
      'Пожалуйста, подождите — мы уведомим вас, когда доступ будет открыт.',
    );
  }

  /** Message shown to blocked users */
  async sendBlockedMessage(ctx: Context) {
    await ctx.reply(
      '🚫 Ваш аккаунт заблокирован администратором.\n' +
      'Доступ к функциям бота запрещён.',
    );
  }

  /** Notify all admins about a new user needing activation */
  async notifyAdminsAboutNewUser(ctx: Context, user: User) {
    const admins = await this.userService.findAllAdmins();
    const name = user.firstName || '—';
    const username = user.username ? `@${user.username}` : '—';
    const created = user.createdAt?.toISOString().replace('T', ' ').slice(0, 19) || '—';

    const message =
      `🆕 **Новый пользователь требует активации**\n\n` +
      `👤 Имя: ${name}\n` +
      `📛 Username: ${username}\n` +
      `🆔 Telegram ID: \`${user.telegramId}\`\n` +
      `📅 Зарегистрирован: ${created}\n\n` +
      `Выберите действие:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Активировать', `activate_${user.telegramId}`),
        Markup.button.callback('🚫 Заблокировать', `block_${user.telegramId}`),
      ],
      [Markup.button.callback('🗑 Удалить', `delnotify_${user.telegramId}`)],
    ]);

    for (const admin of admins) {
      try {
        await ctx.telegram.sendMessage(admin.telegramId, message, {
          parse_mode: 'Markdown',
          ...keyboard,
        });
      } catch (_) {
        // Admin may not have started the bot yet — skip
      }
    }
  }

  /** Notify a user that they have been activated */
  async sendActivationNotificationToUser(ctx: Context, telegramId: number) {
    try {
      await ctx.telegram.sendMessage(
        telegramId,
        '✅ Ваш аккаунт был активирован!\n\n' +
        'Теперь вам доступны все функции бота. Отправьте /start для начала работы.',
      );
    } catch (_) {
      // User may not have started the bot yet — skip
    }
  }

  /** Show admin settings panel */
  async showAdminSettings(ctx: Context) {
    const autoStatus = this.autoActivate ? '🟢 Включено' : '🔴 Выключено';

    const info =
      `⚙️ **Настройки администратора**\n\n` +
      `🤖 Автоактивация после капчи: **${autoStatus}**\n` +
      `(если включено — пользователи активируются автоматически после прохождения капчи, без участия админа)`;

    const buttons: any[][] = [
      [
        this.autoActivate
          ? Markup.button.callback('🔴 Выключить автоактивацию', 'autoact_off')
          : Markup.button.callback('🟢 Включить автоактивацию', 'autoact_on'),
      ],
      [Markup.button.callback('🔙 Назад', 'show_menu')],
    ];

    await ctx.reply(info, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Show list of users for editing (admin only) */
  async showEditUsersList(ctx: Context) {
    const users = await this.userService.findAll();

    if (users.length === 0) {
      await ctx.reply('📭 В базе пока нет пользователей.');
      return;
    }

    const buttons: any[][] = users.map((u) => {
      const roleIcon = u.role === 'admin' ? '👑' : '👤';
      const blockedIcon = u.userIsBlocked ? '🚫' : '';
      const name = u.firstName || u.username || `ID ${u.telegramId}`;
      const label = `${blockedIcon}${roleIcon} ${name}`;
      return [Markup.button.callback(label, `edit_user_${u.telegramId}`)];
    });

    buttons.push([Markup.button.callback('🔙 Назад', 'seeusers')]);

    const message = `📝 **Выберите пользователя для редактирования** (${users.length}):`;
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Show users awaiting activation (admin only) */
  async showPendingUsers(ctx: Context) {
    const users = await this.userService.findPending();

    if (users.length === 0) {
      await ctx.reply('✅ Нет пользователей, ожидающих активации.');
      return;
    }

    const buttons: any[][] = users.map((u) => {
      const name = u.firstName || u.username || `ID ${u.telegramId}`;
      const label = `👤 ${name}`;
      return [Markup.button.callback(label, `edit_user_${u.telegramId}`)];
    });

    buttons.push([Markup.button.callback('🔙 Назад', 'show_menu')]);

    const message = `⏳ **Ожидают активации** (${users.length}):`;
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Show edit fields for a specific user (admin only) */
  async showUserEditFields(ctx: Context, user: User) {
    const roleIcon = user.role === 'admin' ? '👑' : '👤';
    const name = user.firstName || '—';
    const username = user.username ? `@${user.username}` : '—';
    const activeStatus = user.userIsActive ? '✅ Активен' : '⏳ Ожидает активации';
    const blockedStatus = user.userIsBlocked ? '🚫 Заблокирован' : '';

    const info =
      `📝 **Редактирование пользователя**\n\n` +
      `${roleIcon} **${name}** (${username})\n` +
      `🆔 Telegram ID: \`${user.telegramId}\`\n` +
      `💼 Роль: ${user.role}\n` +
      `💰 Баланс: ${user.userBalanceUSDT} USDT / ${user.userBalanceBTC} BTC\n` +
      `📌 Статус: ${activeStatus}\n` +
      (blockedStatus ? `🚫 ${blockedStatus}\n` : '') +
      `📅 Создан: ${user.createdAt?.toISOString().replace('T', ' ').slice(0, 19) || '—'}\n\n` +
      `Выберите поле для редактирования:`;

    const buttons: any[][] = [
      [
        Markup.button.callback('✏️ Имя', `ef_firstName_${user.id}`),
        Markup.button.callback('✏️ Username', `ef_username_${user.id}`),
      ],
      [
        Markup.button.callback('💵 USDT', `ef_userBalanceUSDT_${user.id}`),
        Markup.button.callback('₿ BTC', `ef_userBalanceBTC_${user.id}`),
      ],
      [
        user.role === 'admin'
          ? Markup.button.callback('👤 Сделать User', `er_user_${user.id}`)
          : Markup.button.callback('👑 Сделать Admin', `er_admin_${user.id}`),
      ],
      [
        user.userIsActive
          ? Markup.button.callback('🚫 Деактивировать', `ea_false_${user.id}`)
          : Markup.button.callback('✅ Активировать', `ea_true_${user.id}`),
      ],
      [
        user.userIsBlocked
          ? Markup.button.callback('🔓 Разблокировать', `unblock_${user.telegramId}`)
          : Markup.button.callback('🚫 Заблокировать', `block_${user.telegramId}`),
      ],
      [
        Markup.button.callback('🗑 Удалить', `del_${user.id}`),
        Markup.button.callback('🔙 К списку', 'edit_users'),
      ],
    ];

    await ctx.reply(info, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  async handlePreCheckoutQuery(ctx: Context) {
    await ctx.answerPreCheckoutQuery(true);
  }

  async handleSuccessfulPayment(userId: number, payload: string, ctx: Context) {
    console.log(`Пользователь ${userId} успешно оплатил заказ! Payload: ${payload}`);
    await ctx.reply('🎉 Спасибо за оплату! Ваша подписка успешно активирована.');
  }
}
