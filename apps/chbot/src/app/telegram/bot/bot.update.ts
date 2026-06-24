import {Update, Start, Help, On, Hears, Ctx, Command, Action, Settings} from 'nestjs-telegraf';
import {Context, Markup} from 'telegraf';
import FormData from 'form-data';
import { BotService } from './bot.service';
import {QrCodeService} from "../../qr/qr.service";
import {UserService} from "../../db/user.service";
import {DepositService} from "../../db/deposit.service";
import { TicketService } from '../../db/ticket.service';
import {User} from "../../db/entities/user.entity";
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
  awaitingEditField?: {
    userId: number;
    field: string;
  };
  captchaPending?: {
    answer: number;
    user: User;
  };
  depositFlow?: {
    step: 'currency' | 'txid';
    currency?: string;
  };
  ticketFlow?: {
    step: 'topic' | 'message';
    topic?: string;
  };
  ticketAdmin?: {
    ticketId: number;
    action: 'reply' | 'close';
  };
}

@Update()
export class BotUpdate {
  /** Cooldown per button: "telegramId:action" → last request timestamp */
  private readonly configCooldown = new Map<string, number>();
  private readonly CONFIG_COOLDOWN_MS = 30_000;

  /** Anti-spam: last click time per user */
  private readonly actionCooldown = new Map<number, number>();

  /** Returns true if action is allowed, false if cooldown active */
  private checkActionSpam(ctx: Context, telegramId?: number): boolean {
    const id = telegramId ?? ctx.from?.id;
    if (!id) return true;
    const now = Date.now();
    const cooldownMs = parseInt(process.env.ACTION_COOLDOWN_MS || '1000', 10);
    const last = this.actionCooldown.get(id);
    if (last && (now - last) < cooldownMs) {
      return false; // too fast, silently ignore
    }
    this.actionCooldown.set(id, now);
    return true;
  }

  constructor(
    private readonly botService: BotService,
    private readonly qr: QrCodeService,
    private readonly userService: UserService,
    private readonly depositService: DepositService,
    private readonly ticketService: TicketService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context & { session: SessionData }) {
    const tgUser = ctx.from;
    if (!tgUser) {
      await ctx.reply('Не удалось получить данные пользователя Telegram.');
      return;
    }

    const { user, created } = await this.userService.findOrCreate({
      id: tgUser.id,
      first_name: tgUser.first_name,
      last_name: tgUser.last_name,
      username: tgUser.username,
      language_code: tgUser.language_code,
      is_premium: tgUser.is_premium,
    });

    // Handle referral deep link: /start refCODE
    if (created && !user.referrerId) {
      const payload = (ctx as any).startPayload || (ctx as any).message?.text?.split(' ')?.[1];
      if (payload && payload.startsWith('ref')) {
        const code = payload.replace('ref', '');
        const referrer = await this.userService.findByReferralCode(code);
        if (referrer && referrer.telegramId !== user.telegramId) {
          await this.userService.setReferrer(user.id, referrer.telegramId);
          try {
            await ctx.telegram.sendMessage(
              referrer.telegramId,
              `🎉 По вашей ссылке зарегистрировался новый пользователь!`,
            );
          } catch (_) {}
        }
      }
    }

    // Blocked user — reject immediately
    if (user.userIsBlocked) {
      await this.botService.sendBlockedMessage(ctx);
      return;
    }

    // New user — show CAPTCHA, then activation
    if (created) {
      const name = user.firstName || tgUser.first_name || 'пользователь';
      await ctx.reply(
        `Привет, ${name}! Рад приветствовать тебя!\n\n` +
        `Перед отправкой запроса администратору, докажи что ты не бот 🤖`,
      );
      await this.sendCaptcha(ctx, user);
      return;
    }

    // Existing user but not active — only auto-activate admins
    if (!user.userIsActive) {
      if (this.userService.isAdmin(user.telegramId)) {
        await this.userService.update(user.id, { userIsActive: true });
        const username = user.firstName || tgUser.first_name || 'пользователь';
        const message = this.botService.getWelcomeMessage(username);
        await ctx.reply(`${message} ✅ Ваш аккаунт автоматически активирован (админ).`);
        await this.botService.botMenu(ctx);
        return;
      }
      const name = user.firstName || tgUser.first_name || 'пользователь';
      await ctx.reply(
        `Привет, ${name}!\n\n` +
        `⏳ Ваш аккаунт всё ещё ожидает активации администратором. ` +
        `Пожалуйста, подождите — мы уведомим вас, когда доступ будет открыт.`,
      );
      return;
    }

    // Active user — normal flow
    const username = user.firstName || tgUser.first_name || 'пользователь';
    const message = this.botService.getWelcomeMessage(username);
    await ctx.reply(`${message} 👋 С возвращением!`);
    await this.botService.botMenu(ctx);
  }

  // ─── CAPTCHA handlers ──────────────────────────────────────

  @Action(/^captcha_(\-?\d+)$/)
  async onCaptchaAnswer(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();

    const pending = ctx.session?.captchaPending;
    if (!pending) {
      await ctx.reply('⌛ Капча устарела. Отправьте /start чтобы начать заново.');
      return;
    }

    const match = (ctx as any).match;
    const userAnswer = parseInt(match[1], 10);

    if (userAnswer === pending.answer) {
      ctx.session.captchaPending = undefined;
      const user = pending.user;

      // Auto-activate if enabled in admin settings
      if (this.botService.autoActivate) {
        await this.userService.update(user.id, { userIsActive: true });
        await ctx.reply(
          `✅ Верно! Ты человек.\n\n` +
          `🎉 Ваш аккаунт активирован автоматически! Отправьте /start для начала работы.`,
        );
        await this.botService.sendActivationNotificationToUser(ctx, user.telegramId);
      } else {
        await ctx.reply(
          `✅ Верно! Ты человек.\n\n` +
          `⏳ Ваш аккаунт ожидает активации администратором. ` +
          `Пожалуйста, подождите — мы уведомим вас, когда доступ будет открыт.`,
        );
        await this.botService.notifyAdminsAboutNewUser(ctx, user);
      }
    } else {
      await ctx.reply('❌ Неверно. Попробуй ещё раз:');
      await this.sendCaptcha(ctx, pending.user);
    }
  }

  // ─── Admin Settings handlers ───────────────────────────────

  @Action('admin_settings')
  async onAdminSettings(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showAdminSettings(ctx);
  }

  @Action('autoact_on')
  async onAutoActOn(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    this.botService.autoActivate = true;
    await ctx.reply('🟢 Автоактивация **включена**.', { parse_mode: 'Markdown' });
    await this.botService.showAdminSettings(ctx);
  }

  @Action('autoact_off')
  async onAutoActOff(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    this.botService.autoActivate = false;
    await ctx.reply('🔴 Автоактивация **выключена**.', { parse_mode: 'Markdown' });
    await this.botService.showAdminSettings(ctx);
  }

  // ─── Show menu callback (back button) ──────────────────────

  @Action('show_menu')
  async onShowMenu(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    await this.botService.showMenu(ctx);
  }

  // ─── Notification actions (block / delete from notify) ─────

  /** Block user from admin notification or edit screen */
  @Action(/^block_(\d+)$/)
  async onBlockUser(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const telegramId = parseInt(match[1], 10);
    const user = await this.userService.findByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    if (user.userIsBlocked) {
      await ctx.answerCbQuery('Уже заблокирован');
      return;
    }

    await this.userService.update(user.id, { userIsBlocked: true });
    const name = user.firstName || user.username || `ID ${telegramId}`;

    // Edit the original message to remove action buttons
    try {
      await ctx.editMessageText(
        `🚫 Пользователь **${name}** заблокирован.`,
        { parse_mode: 'Markdown' },
      );
    } catch (_) {
      // Fallback: send as new reply
      await ctx.reply(
        `🚫 Пользователь **${name}** заблокирован.`,
        { parse_mode: 'Markdown' },
      );
    }

    // Refresh edit fields if triggered from edit screen
    const updated = await this.userService.findByTelegramId(telegramId);
    if (updated) {
      await this.botService.showUserEditFields(ctx, updated);
    }
  }

  /** Unblock user from edit screen */
  @Action(/^unblock_(\d+)$/)
  async onUnblockUser(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const telegramId = parseInt(match[1], 10);
    const user = await this.userService.findByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    await this.userService.update(user.id, { userIsBlocked: false });
    const name = user.firstName || user.username || `ID ${telegramId}`;
    await ctx.reply(`🔓 Пользователь **${name}** разблокирован.`, { parse_mode: 'Markdown' });
    await this.botService.showUserEditFields(ctx, (await this.userService.findByTelegramId(telegramId))!);
  }

  /** Delete user from admin notification (with confirmation) */
  @Action(/^delnotify_(\d+)$/)
  async onDeleteFromNotify(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const telegramId = parseInt(match[1], 10);
    const user = await this.userService.findByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    const name = user.firstName || user.username || `ID ${telegramId}`;
    await ctx.reply(
      `⚠️ **Удалить пользователя?**\n\n${name}\nTelegram ID: \`${telegramId}\`\n\nЭто действие необратимо!`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Да, удалить', `delyes_${user.id}`),
            Markup.button.callback('❌ Нет', 'edit_users'),
          ],
        ]),
      },
    );
  }

  // ─── Text handler ────────────────────────────────────────────

  @Command('menu')
  async menu(@Ctx() ctx: Context & { session: SessionData }) {
    if (!(await this.checkActive(ctx))) return;
    await this.botService.showMenu(ctx);
  }

  @Help()
  async help(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    await ctx.reply('Доступные команды: /start, /help. Или просто отправьте текст.');
  }

  // ─── Keyboard button handlers ────────────────────────────

  @Hears('🔌 Подключить VPN')
  async onKeyboardConnect(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    await this.botService.showBuySubscription(ctx);
  }



  @Hears('👤 Профиль')
  async onKeyboardProfile(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) return;
    await this.botService.showMySubscription(ctx, dbUser);
  }

  @Action('invite_friend')
  async onInviteFriend(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    await this.showReferralInfo(ctx);
  }

  @Action('gift_sub')
  async onGiftSub(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    await ctx.reply(
      '🎁 **Подарить подписку**\n\n' +
      'Вы можете подарить подписку другому пользователю.\n\n' +
      '🚧 Раздел в разработке.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'my_subscription')],
        ]),
      },
    );
  }

  // ─── Support tickets ──────────────────────────────────────

  @Action('cancel_action')
  async onCancelAction(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (ctx.session?.depositFlow) {
      ctx.session.depositFlow = undefined;
      await this.botService.showTopUpBalance(ctx);
      return;
    }
    if (ctx.session?.ticketFlow) {
      ctx.session.ticketFlow = undefined;
      // Redirect back to support menu (without double answerCbQuery)
      await this.showSupportMenu(ctx);
      return;
    }
    if (ctx.session?.ticketAdmin) {
      ctx.session.ticketAdmin = undefined;
      if (this.isAdminOrSupport(ctx)) {
        await this.showAdminTickets(ctx);
      } else {
        await this.showSupportMenu(ctx);
      }
      return;
    }
    if (ctx.session?.awaitingEditField?.field === 'referrer_code') {
      ctx.session.awaitingEditField = undefined;
      await this.showReferralInfo(ctx);
      return;
    }
    await ctx.answerCbQuery('Нет активных действий для отмены.');
  }

  /** Show tech support main page */
  @Action('create_ticket')
  async onSupportMenu(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    await this.showSupportMenu(ctx);
  }

  /** Shared support menu (no answerCbQuery) */
  private async showSupportMenu(ctx: Context) {
    if (!(await this.checkActive(ctx))) return;

    const tgUser = ctx.from!;
    const maxOpen = parseInt(process.env.MAX_OPEN_TICKETS || '3', 10);
    const openCount = await this.ticketService.countOpenByUserId(tgUser.id);

    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    const hasSub = dbUser ? await this.botService.hasActiveSubscription(dbUser) : false;
    const cooldownMin = parseInt(process.env[hasSub ? 'TICKET_TIME_WITH_SUB' : 'TICKET_TIME_NO_SUB'] || '10', 10);

    await ctx.reply(
      `🛟 **Техническая поддержка**\n\n` +
      `📊 Открыто тикетов: ${openCount}/${maxOpen}\n` +
      `⏱ Интервал между тикетами: ${cooldownMin} мин.\n\n` +
      `Выберите действие:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📝 Создать тикет', 'new_ticket')],
          [Markup.button.callback('📋 Текущие тикеты', 'my_tickets')],
          [Markup.button.callback('📁 Закрытые тикеты', 'closed_tickets')],
          [Markup.button.callback('🔙 Назад', 'my_subscription')],
        ]),
      },
    );
  }

  /** Start ticket creation flow */
  @Action('new_ticket')
  async onNewTicket(@Ctx() ctx: Context & { session: SessionData }) {
    await ctx.answerCbQuery();
    if (!this.checkActionSpam(ctx, ctx.from!.id)) return;
    if (!(await this.checkActive(ctx))) return;

    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    const hasSub = dbUser ? await this.botService.hasActiveSubscription(dbUser) : false;
    const hasBalance = (dbUser?.userBalanceUSDT ?? 0) > 0;

    if (!hasSub && !hasBalance) {
      await ctx.reply(
        '⚠️ Для создания обращения необходима активная подписка или баланс > 0.',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const maxOpen = parseInt(process.env.MAX_OPEN_TICKETS || '3', 10);
    const openCount = await this.ticketService.countOpenByUserId(tgUser.id);
    if (openCount >= maxOpen) {
      await ctx.reply(
        `⚠️ У вас уже ${openCount}/${maxOpen} открытых обращений.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const cooldownMin = parseInt(process.env[hasSub ? 'TICKET_TIME_WITH_SUB' : 'TICKET_TIME_NO_SUB'] || '10', 10);
    const recent = await this.ticketService.hasRecentTicket(tgUser.id, cooldownMin);
    if (recent) {
      await ctx.reply(`⏳ Интервал между тикетами: ${cooldownMin} мин. Пожалуйста, подождите.`);
      return;
    }

    ctx.session.ticketFlow = { step: 'topic' };
    await ctx.reply(
      `📝 **Новый тикет**\n\nВведите **тему** обращения:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отменить', 'cancel_action')],
        ]),
      },
    );
  }

  /** Show user's open tickets */
  @Action('my_tickets')
  async onMyTicketsList(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkActionSpam(ctx, ctx.from!.id)) return;
    if (!(await this.checkActive(ctx))) return;

    const tgUser = ctx.from!;
    const tickets = (await this.ticketService.findByUserId(tgUser.id))
      .filter((t) => t.status === 'open');

    if (tickets.length === 0) {
      await ctx.reply('📭 Нет открытых тикетов.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'create_ticket')],
        ]),
      });
      return;
    }

    const autoClose = process.env.ENABLE_AUTO_CLOSE_TICKET !== 'false';
    const autoCloseHours = parseInt(process.env.AUTO_CLOSE_TICKET_TIME_AFTER_ANSWER || '48', 10);

    const shown = tickets.slice(0, 5);
    for (let idx = 0; idx < shown.length; idx++) {
      const t = shown[idx];
      const isLast = idx === shown.length - 1;
      const replies: any[] = JSON.parse(t.replies || '[]');

      // Auto-close if enabled, ticket is open, has replies, and last reply is old enough
      if (autoClose && t.status === 'open' && replies.length > 0) {
        const lastReply = new Date(replies[replies.length - 1].createdAt);
        if ((Date.now() - lastReply.getTime()) > autoCloseHours * 3600_000) {
          await this.ticketService.close(t.id);
          t.status = 'closed';
        }
      }

      const statusIcon = t.status === 'open' ? '🟢' : '🔴';
      const statusText = t.status === 'open' ? 'Открыт' : 'Закрыт';
      let replyText = replies.length > 0
        ? '\n📩 Ответы:\n' + replies.map((r: any) => `👤 ${r.userName}: ${r.message}`).join('\n')
        : '';

      const buttons: any[][] = [];
      let waitText = '';
      if (t.status === 'open') {
        const canReply = replies.length > 0 && replies[replies.length - 1].userId !== tgUser.id;
        if (canReply) {
          buttons.push([Markup.button.callback('📝 Ответить', `user_reply_ticket_${t.id}`)]);
        } else {
          waitText = '\n⏳ Ожидается ответ от техподдержки, пожалуйста дождитесь ответа. Обычно он занимает до 3 часов, в крайнем случае до 24 часов.';
        }
        buttons.push([Markup.button.callback('🔴 Закрыть тикет', `close_my_ticket_${t.id}`)]);
      }
      if (isLast) {
        buttons.push([Markup.button.callback('🔙 Назад', 'create_ticket')]);
      }

      const bodyText =
        `${statusIcon} **Тикет #${t.id} ${statusText}** — ${t.topic}\n` +
        `💬 ${t.message}\n` +
        `📅 ${t.createdAt.toISOString().replace('T', ' ').slice(0, 19)}` +
        replyText +
        (waitText ? `\n\n${waitText}` : '');

      await ctx.reply(
        bodyText,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) },
      );
    }

  }

  /** Show closed tickets */
  @Action('closed_tickets')
  async onClosedTickets(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkActionSpam(ctx, ctx.from!.id)) return;
    if (!(await this.checkActive(ctx))) return;

    const tgUser = ctx.from!;
    const tickets = await this.ticketService.findByUserId(tgUser.id);
    const closed = tickets.filter((t) => t.status === 'closed');

    if (closed.length === 0) {
      await ctx.reply('📭 Нет закрытых тикетов.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'create_ticket')]]),
      });
      return;
    }

    const shown = closed.slice(0, 5);
    for (let idx = 0; idx < shown.length; idx++) {
      const t = shown[idx];
      const isLast = idx === shown.length - 1;
      const replies: any[] = JSON.parse(t.replies || '[]');
      const replyText = replies.length > 0
        ? '\n📩 Ответы:\n' + replies.map((r: any) => `👤 ${r.userName}: ${r.message}`).join('\n')
        : '';

      const buttons: any[][] = [];
      if (isLast) {
        buttons.push([Markup.button.callback('🔙 Назад', 'create_ticket')]);
      }

      await ctx.reply(
        `🔴 **Тикет #${t.id} Закрыт** — ${t.topic}\n` +
        `💬 ${t.message}\n` +
        `📅 ${t.createdAt.toISOString().replace('T', ' ').slice(0, 19)}` +
        replyText,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) },
      );
    }
  }

  /** User replies to their ticket from notification */
  @Action(/^user_reply_ticket_(\d+)$/)
  async onUserReplyTicket(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    const match = (ctx as any).match;
    const ticketId = parseInt(match[1], 10);
    const ticket = await this.ticketService.findById(ticketId);

    if (!ticket) {
      await ctx.reply('❌ Тикет не найден.');
      return;
    }

    const tgUser = ctx.from!;
    const isAdmin = this.isAdminOrSupport(ctx);
    if (ticket.userId !== tgUser.id && !isAdmin) {
      await ctx.answerCbQuery('⛔ Нет доступа.');
      return;
    }

    // Users can only reply after support has responded
    if (!isAdmin) {
      const replies: any[] = JSON.parse(ticket.replies || '[]');
      if (replies.length === 0) {
        await ctx.reply('⏳ Дождитесь ответа поддержки перед отправкой нового сообщения.');
        return;
      }
      const lastReply = replies[replies.length - 1];
      if (lastReply.userId === tgUser.id) {
        await ctx.reply('⏳ Дождитесь ответа поддержки перед отправкой нового сообщения.');
        return;
      }
    }

    ctx.session.ticketAdmin = { ticketId, action: 'reply' };
    await ctx.reply(
      '📝 Введите **ответ** на тикет:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отменить', 'cancel_action')],
        ]),
      },
    );
  }

  /** User closes their own ticket */
  @Action(/^close_my_ticket_(\d+)$/)
  async onCloseMyTicket(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    const match = (ctx as any).match;
    const ticketId = parseInt(match[1], 10);
    const ticket = await this.ticketService.findById(ticketId);

    if (!ticket) {
      await ctx.reply('❌ Тикет не найден.');
      return;
    }

    const tgUser = ctx.from!;
    if (ticket.userId !== tgUser.id && !this.checkAdmin(ctx) && !this.checkSupport(ctx)) {
      await ctx.answerCbQuery('⛔ Нет доступа.');
      return;
    }

    await this.ticketService.close(ticketId);
    await ctx.reply('🔴 Тикет закрыт.');
    // Refresh tickets list
    await this.onMyTicketsList(ctx);
  }

  @Action('admin_tickets')
  async onAdminTickets(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    await this.showAdminTickets(ctx);
  }

  /** Shared admin tickets list (no answerCbQuery) */
  private async showAdminTickets(ctx: Context) {
    if (!this.checkAdmin(ctx) && !this.checkSupport(ctx)) return;

    const tickets = await this.ticketService.findOpen();
    if (tickets.length === 0) {
      await ctx.reply('✅ Нет открытых тикетов.');
      return;
    }

    // Sort by createdAt ascending (oldest first)
    tickets.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const buttons: any[][] = tickets.slice(0, 10).map((t) => [
      Markup.button.callback(`#${t.id} [ID:${t.userId}]: ${t.topic.slice(0, 25)}`, `viewticket_${t.id}`),
    ]);

    await ctx.reply('🛟 **Тикеты пользователей**', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  @Action(/^viewticket_(\d+)$/)
  async onViewTicket(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx) && !this.checkSupport(ctx)) return;

    const match = (ctx as any).match;
    const ticketId = parseInt(match[1], 10);
    await this.showTicketInfo(ctx, ticketId);
  }

  /** Admin: start reply flow */
  @Action(/^replyticket_(\d+)$/)
  async onReplyTicket(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx) && !this.checkSupport(ctx)) return;

    const match = (ctx as any).match;
    const ticketId = parseInt(match[1], 10);

    ctx.session.ticketAdmin = { ticketId, action: 'reply' };
    await ctx.reply(
      '📝 Введите **ответ** на тикет:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отменить', 'cancel_action')],
        ]),
      },
    );
  }

  @Action(/^closeticket_(\d+)$/)
  async onCloseTicket(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx) && !this.checkSupport(ctx)) return;

    const match = (ctx as any).match;
    const ticketId = parseInt(match[1], 10);

    ctx.session.ticketAdmin = { ticketId, action: 'close' };
    await ctx.reply(
      '🔴 Введите **причину закрытия** тикета:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отменить', 'cancel_action')],
        ]),
      },
    );
  }

  /** Check if user is admin or support — no side effects (no error messages) */
  private isAdminOrSupport(ctx: Context): boolean {
    const tgUser = ctx.from;
    if (!tgUser) return false;
    return this.userService.isAdmin(tgUser.id) || this.botService.getSupportIds().includes(tgUser.id);
  }

  /** Show ticket info without answerCbQuery (safe for text context) */
  private async showTicketInfo(ctx: Context, ticketId: number) {
    const ticket = await this.ticketService.findById(ticketId);
    if (!ticket) {
      await ctx.reply('❌ Тикет не найден.');
      return;
    }

    const replies: any[] = JSON.parse(ticket.replies || '[]');
    const replyText = replies.length > 0
      ? '\n📩 Ответы:\n' + replies.map((r: any) => `👤 ${r.userName}: ${r.message}`).join('\n')
      : '\n📩 Ответов пока нет';

    const stIcon = ticket.status === 'open' ? '🟢' : '🔴';
    const stText = ticket.status === 'open' ? 'Открыт' : 'Закрыт';

    const buttons: any[][] = [];
    if (ticket.status === 'open') {
      buttons.push([Markup.button.callback('📝 Ответить', `replyticket_${ticket.id}`)]);
      buttons.push([Markup.button.callback('🔴 Закрыть тикет', `closeticket_${ticket.id}`)]);
    }
    buttons.push([Markup.button.callback('🔙 К списку тикетов', 'admin_tickets')]);

    await ctx.reply(
      `${stIcon} **Тикет #${ticket.id} ${stText}**\n` +
      `👤 ID пользователя: \`${ticket.userId}\`\n` +
      `📌 Тема: ${ticket.topic}\n` +
      `💬 Сообщение: ${ticket.message}\n` +
      `📅 ${ticket.createdAt.toISOString().replace('T', ' ').slice(0, 19)}` +
      replyText,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      },
    );
  }

  /** Check if user is support staff */
  private checkSupport(ctx: Context): boolean {
    const tgUser = ctx.from;
    if (!tgUser) return false;
    const ids = this.botService.getSupportIds();
    return ids.includes(tgUser.id);
  }

  /** Show referral program info with stats */
  private async showReferralInfo(ctx: Context) {
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) return;

    const code = dbUser.referralCode || '—';
    const stats = await this.botService.getReferralStats(dbUser.telegramId);

    const rewardType = process.env.REFERRAL_REWARD_TYPE || 'usdt';
    const { percent, level } = this.botService.getReferralLevel(stats.activeReferrals);
    const firstBonus = parseFloat(process.env.REFERRAL_FIRST_PURCHASE_BONUS || '0');
    const unit = rewardType === 'usdt' ? 'USDT' : 'дней';

    // Build levels info text
    const raw = process.env.REFERRAL_LEVELS || '0:5,5:7,15:10';
    const entries = raw.split(',').map((s) => {
      const [min, pct] = s.split(':').map(Number);
      return { min: min || 0, percent: pct || 5 };
    }).sort((a, b) => a.min - b.min);

    let levelsText = '';
    let nextLevelText = '';
    for (let i = 0; i < entries.length; i++) {
      const marker = i + 1 === level ? ' ◀' : '';
      levelsText += `  ${i + 1}. ${entries[i].min}+ чел. → ${entries[i].percent}%${marker}\n`;
      if (stats.activeReferrals < entries[i].min && !nextLevelText) {
        const need = entries[i].min - stats.activeReferrals;
        nextLevelText = `\n📅 До следующего уровня: ещё ${need} активных`;
      }
    }

    const buttons: any[][] = [
      [Markup.button.callback('🔗 Поделиться ссылкой', 'share_ref')],
    ];
    if (!dbUser.referrerId) {
      buttons.push([Markup.button.callback('✏️ Добавить пригласившего', 'set_referrer')]);
    }
    buttons.push([Markup.button.callback('🔙 Назад', 'my_subscription')]);

    // Referrer who invited this user
    let refInviteLine = '';
    if (dbUser.referrerId) {
      const refUser = await this.userService.findByTelegramId(dbUser.referrerId);
      if (refUser) {
        const refName = refUser.firstName || refUser.username || `ID ${refUser.telegramId}`;
        refInviteLine = `👤 Вас пригласил: **${refName}**\n\n`;
      }
    }

    await ctx.reply(
      `🏆 **Реферальная программа**\n\n` +
      `${refInviteLine}` +
      `⭐ Ваш уровень: ${level} (${percent}%)\n` +
      `🎁 Единоразовый приветственный бонус за каждого нового, пополнившего баланс, реферала: **${firstBonus} ${unit}**\n\n` +
      `💡 Наша реферальная программа помогает пользоваться сервисом бесплатно! ` +
      `С большим кол-вом рефералов, Вам не придется платить за сервис! ` +
      `% от пополнения каждого реферала, возвращается Вам на баланс!\n\n` +
      `📊 Уровни рефералов:\n${levelsText}\n` +
      `🔗 Ваша ссылка:\n\`t.me/Amnbot3bot?start=ref${code}\`\n\n` +
      `📊 Статистика:\n` +
      `👥 Приглашено: ${stats.totalReferrals}\n` +
      `💳 Активных: ${stats.activeReferrals}\n` +
      `💰 Заработано: ${stats.totalEarned.toFixed(2)} USDT` +
      `${nextLevelText}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      },
    );
  }

  /** Share referral link */
  @Action('share_ref')
  async onShareRef(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    const code = dbUser?.referralCode || '';
    await ctx.reply(
      `🔗 Приглашаю в HideFox VPN-сервис!\n\n` +
      `• Пробный период — 24 часа\n` +
      `• Оплата криптовалютой\n` +
      `• Свой ключ для каждого устройства\n\n` +
      `Переходи: t.me/Amnbot3bot?start=ref${code}`,
    );
  }

  /** Set referrer code */
  @Action('set_referrer')
  async onSetReferrer(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    ctx.session.awaitingEditField = { userId: 0, field: 'referrer_code' as any };
    await ctx.reply(
      '✏️ Введите **реферальный код** друга:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отменить', 'cancel_action')],
          [Markup.button.callback('🔙 Назад', 'invite_friend')],
        ]),
      },
    );
  }

  /** Create ticket and notify support */
  private async handleTicketCreate(ctx: Context, topic: string, message: string) {
    const tgUser = ctx.from!;
    const ticket = await this.ticketService.create({
      userId: tgUser.id,
      topic,
      message,
    });

    // Notify support staff
    const supportIds = this.botService.getSupportIds();
    const userName = tgUser.first_name || tgUser.username || `ID ${tgUser.id}`;
    for (const sid of supportIds) {
      try {
        await ctx.telegram.sendMessage(
          sid,
          `🛟 **Новый тикет #${ticket.id}**\n` +
          `👤 ${userName} (\`${tgUser.id}\`)\n` +
          `📌 ${topic}\n` +
          `💬 ${message}`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📝 Ответить', `viewticket_${ticket.id}`)],
            ]),
          },
        );
      } catch (_) {}
    }
    // Redirect back to support menu
    await this.showSupportMenu(ctx);
  }

  @Hears('🎁 Реферальная программа')
  async onKeyboardReferral(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    await this.showReferralInfo(ctx);
  }

  @Hears('ℹ️ Информация')
  async onKeyboardInfo(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    await ctx.reply(
      'ℹ️ **Информация**\n\n' +
      '🔐 Сервис HideFox VPN\n' +
      '💳 Оплата криптовалютой (BTC, USDT, GRAM)\n' +
      '📅 Пробный период — 24 часа\n' +
      '🔑 Поддержка нескольких ключей\n\n' +
      'По вопросам: обратитесь к администратору.\n' +
      'Команды: /start /menu /help',
      { parse_mode: 'Markdown' },
    );
  }

  @Hears('whoami')
  async onWhoAmI(@Ctx() ctx: Context & { session: SessionData }) {
    if (!(await this.checkActive(ctx))) return;

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
        `Роль: ${dbUser?.role || '—'}\n` +
        `Баланс: ${dbUser?.userBalanceUSDT} USDT / ${dbUser?.userBalanceBTC} BTC / ${dbUser?.userBalanceGram} GRAM\n` +
        `Статус: ${dbUser?.userIsActive ? '✅ Активен' : '⏳ Ожидает активации'}\n` +
        `Создан: ${dbUser?.createdAt?.toISOString() || '—'}\n` +
        `\n🔑 Auth token: \`${dbUser?.authToken?.slice(0, 16)}...\``,
      { parse_mode: 'Markdown' },
    );
  }

  @Hears('id')
  async onSecretWord(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    await ctx.reply(`Ваш Telegram ID: ${ctx.from?.id}`);
  }

  @Hears('what?')
  async onWhat(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
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

  @Action('balance')
  async onBalance(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkActionSpam(ctx, ctx.from!.id)) return;
    if (!(await this.checkActive(ctx))) return;

    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    await this.botService.showUserBalance(ctx, dbUser);
  }

  @Action('my_subscription')
  async onMySubscription(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkActionSpam(ctx, ctx.from!.id)) return;
    if (!(await this.checkActive(ctx))) return;

    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    await this.botService.showMySubscription(ctx, dbUser);
  }

  @Action('buy')
  async onBuy(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    await this.botService.showBuySubscription(ctx);
  }

  /** User selected a plan to buy with balance */
  @Action(/^buyplan_(\d+)$/)
  async onBuyPlan(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    const match = (ctx as any).match;
    const hours = parseInt(match[1], 10);
    await this.botService.purchaseSubscriptionWithBalance(ctx, hours);
  }

  /** Show top-up page with payment addresses */
  @Action('top_up')
  async onTopUp(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    await this.botService.showTopUpBalance(ctx);
  }

  // ─── Deposit flow ──────────────────────────────────────────

  @Action('i_paid')
  async onIPaid(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    ctx.session.depositFlow = { step: 'currency' };
    await this.botService.showDepositCurrencySelect(ctx);
  }

  @Action(/^dep_currency_(BTC|USDT|GRAM)$/)
  async onDepositCurrency(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    const match = (ctx as any).match;
    const currency = match[1];
    ctx.session.depositFlow = { step: 'txid', currency };
    await this.botService.showTxIdPrompt(ctx, currency);
  }

  // ─── Admin pending deposits ────────────────────────────────

  @Action('pending_deposits')
  async onPendingDeposits(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showPendingDeposits(ctx);
  }

  @Action(/^confdep_(\d+)$/)
  async onConfirmDeposit(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const depositId = parseInt(match[1], 10);
    try {
      const deposit = await this.depositService.confirm(depositId);
      const rawAmount = deposit.verifiedAmount ?? deposit.amount;

      // Always credit in USDT (auto-convert if needed)
      const usdtAmount = await this.botService.convertToUsdt(rawAmount, deposit.currency);
      await this.userService.creditBalance(deposit.userId, 'USDT', usdtAmount);

      // Referral reward
      const reward = await this.botService.processReferralReward(deposit.userId, usdtAmount);
      if (reward) {
        const unit = reward.rewardType === 'usdt' ? 'USDT' : 'дней';
        const referrer = await this.userService.findById(deposit.userId);
        if (referrer?.referrerId) {
          try {
            await ctx.telegram.sendMessage(
              referrer.referrerId,
              `🎁 **Реферальное вознаграждение!**\n\n` +
              `👤 Пополнение от реферала\n` +
              `💰 +${reward.totalReward} ${unit} (${reward.percent}%${reward.firstBonus > 0 ? ` + бонус ${reward.firstBonus} ${unit}` : ''})\n` +
              `⭐ Уровень: ${reward.level}`,
              { parse_mode: 'Markdown' },
            );
          } catch (_) {}
        }
      }

      if (deposit.currency === 'USDT') {
        await ctx.reply(`✅ Пополнение подтверждено, +${usdtAmount.toFixed(2)} USDT зачислено на баланс.`);
      } else {
        await ctx.reply(
          `✅ Пополнение подтверждено!\n` +
          `${rawAmount} ${deposit.currency} → **${usdtAmount.toFixed(2)} USDT** по курсу.`,
          { parse_mode: 'Markdown' },
        );
      }
    } catch {
      await ctx.reply('❌ Ошибка: пополнение не найдено.');
    }
  }

  @Action(/^rejdep_(\d+)$/)
  async onRejectDeposit(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const depositId = parseInt(match[1], 10);
    try {
      await this.depositService.reject(depositId, 'Отклонено администратором');
      await ctx.reply('❌ Пополнение отклонено.');
    } catch {
      await ctx.reply('❌ Ошибка: пополнение не найдено.');
    }
  }

  /** Show "Профиль" page */
  @Action('vpn_config')
  async onVpnConfig(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    if (!(await this.checkSubscription(ctx))) return;
    await this.botService.showVpnKeys(ctx);
  }

  /** Show list of keys for config */
  @Action('vpn_keys')
  async onVpnKeys(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    if (!(await this.checkSubscription(ctx))) return;
    await this.botService.showVpnKeys(ctx);
  }

  /** Show actions for a specific key */
  @Action(/^keycfg_(\d+)$/)
  async onKeyConfig(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    if (!(await this.checkSubscription(ctx))) return;

    const match = (ctx as any).match;
    const keyId = parseInt(match[1], 10);
    await this.botService.showKeyActions(ctx, keyId);
  }

  @Action(/^getlink_(\d+)$/)
  async onGetLink(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) return;
    this.safeAnswerCbQuery(ctx);
    const chatId = ctx.chat!.id;
    const tgUser = ctx.from!;

    if (!(await this.checkActive(ctx))) return;
    if (!this.checkConfigCooldown(ctx, tgUser.id, 'link')) return;

    const match = (ctx as any).match;
    const keyId = parseInt(match[1], 10);

    const key = await this.botService.getVpnKey(keyId);
    if (!key) { await ctx.reply('❌ Ключ не найден.'); return; }

    const config = await this.botService.getKeyConfig(key);
    if (!config) {
      await ctx.reply('❌ Не удалось получить конфигурацию VPN.');
      return;
    }

    await this.sendFileDirectly(
      'sendDocument',
      chatId,
      Buffer.from(config, 'utf-8'),
      `amnezia_key${key.keyIndex}.conf`,
      `🔐 Key${key.keyIndex} — конфигурация HideFox VPN`,
    );
  }

  @Action(/^getqr_(\d+)$/)
  async onGetQR(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) return;
    this.safeAnswerCbQuery(ctx);
    const chatId = ctx.chat!.id;
    const tgUser = ctx.from!;

    if (!(await this.checkActive(ctx))) return;
    if (!this.checkConfigCooldown(ctx, tgUser.id, 'qr')) return;

    const match = (ctx as any).match;
    const keyId = parseInt(match[1], 10);

    const key = await this.botService.getVpnKey(keyId);
    if (!key) { await ctx.reply('❌ Ключ не найден.'); return; }

    const config = await this.botService.getKeyConfig(key);
    if (!config) {
      await ctx.reply('❌ Не удалось получить конфигурацию VPN.');
      return;
    }

    const qrBuffer = await this.qr.generateQrBuffer(config);
    await this.sendFileDirectly(
      'sendPhoto',
      chatId,
      qrBuffer,
      `amnezia_key${key.keyIndex}.png`,
      `📱 Key${key.keyIndex} — отсканируйте QR-код`,
    );
  }

  /** Delete key: confirmation step */
  @Action(/^delkey_(\d+)$/)
  async onDeleteKeyConfirm(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    const match = (ctx as any).match;
    const keyId = parseInt(match[1], 10);
    const key = await this.botService.getVpnKey(keyId);
    if (!key) { await ctx.reply('❌ Ключ не найден.'); return; }

    await ctx.reply(
      `⚠️ **Удаление ключа Key${key.keyIndex}**\n\n` +
      `Это действие **необратимо**!\n\n` +
      `• Средства на баланс **не возвращаются**\n` +
      `• Мы **не храним** Ваши личные данные\n` +
      `• Восстановление **невозможно** ввиду отсутствия копий\n\n` +
      `Вы уверены?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Да, удалить', `confirmdel_${key.id}`)],
          [Markup.button.callback('❌ Нет', `keycfg_${key.id}`)],
        ]),
      },
    );
  }

  /** Execute key deletion */
  @Action(/^confirmdel_(\d+)$/)
  async onDeleteKeyExecute(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    const match = (ctx as any).match;
    const keyId = parseInt(match[1], 10);
    const key = await this.botService.getVpnKey(keyId);
    if (!key) { await ctx.reply('❌ Ключ не найден.'); return; }

    // Verify ownership or admin
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser || (key.userId !== dbUser.id && !this.userService.isAdmin(tgUser.id))) {
      await ctx.reply('⛔ Нет доступа.');
      return;
    }

    // Delete from HideFox VPN
    await this.botService.deleteKey(key);
    await ctx.reply(`🗑 Ключ **Key${key.keyIndex}** удалён.`, { parse_mode: 'Markdown' });

    // Show updated subscription page
    await this.botService.showMySubscription(ctx, dbUser);
  }

  @Action(/^otlink_(\d+)$/)
  async onOneTimeLink(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) return;
    this.safeAnswerCbQuery(ctx);
    const chatId = ctx.chat!.id;
    const tgUser = ctx.from!;

    if (!(await this.checkActive(ctx))) return;
    if (!this.checkConfigCooldown(ctx, tgUser.id, 'onetime')) return;

    const match = (ctx as any).match;
    const keyId = parseInt(match[1], 10);

    const key = await this.botService.getVpnKey(keyId);
    if (!key) { await ctx.reply('❌ Ключ не найден.'); return; }

    await ctx.reply('⏳ Генерирую одноразовую ссылку...');

    const link = await this.botService.getOneTimeLink(keyId);
    if (!link) {
      await ctx.reply('❌ Не удалось создать одноразовую ссылку.');
      return;
    }

    await ctx.telegram.sendMessage(
      chatId,
      `🔗 **Key${key.keyIndex} — одноразовая ссылка**\n\n` +
      `[Скачать конфигурацию](${link})\n\n` +
      `⚠️ Ссылка действительна **однократно**.`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
    );
  }

  @Action('wizard_test')
  async wizardTest(@Ctx() ctx: Context): Promise<void> {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    await (ctx as any).scene.enter(WIZARD_SCENE_ID);
  }

  @Action('scene_test')
  async sceneTest(@Ctx() ctx: Context): Promise<void> {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
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

  // ─── Activation via inline button ────────────────────────────

  @Action(/^activate_(\d+)$/)
  async onActivateUser(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    await this.handleActivateUser(ctx);
  }

  /** Show users awaiting activation (admin) */
  @Action('pending_users')
  async onPendingUsers(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showPendingUsers(ctx);
  }

  // ─── Edit Users actions ──────────────────────────────────────

  @Action('edit_users')
  async onEditUsers(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showEditUsersList(ctx);
  }

  @Action(/^edit_user_(\d+)$/)
  async onEditUser(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const telegramId = parseInt(match[1], 10);
    const user = await this.userService.findByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    await this.botService.showUserEditFields(ctx, user);
  }

  @Action(/^ef_(\w+)_(\d+)$/)
  async onEditField(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const field = match[1];
    const userId = parseInt(match[2], 10);

    const validFields = ['firstName', 'username', 'userBalanceUSDT', 'userBalanceBTC', 'userBalanceGram', 'subscriptionExpiresAt'];
    if (!validFields.includes(field)) {
      await ctx.reply('❌ Неизвестное поле для редактирования.');
      return;
    }

    const fieldLabels: Record<string, string> = {
      firstName: 'Имя',
      username: 'Username',
      userBalanceUSDT: 'баланс USDT',
      userBalanceBTC: 'баланс BTC',
      userBalanceGram: 'баланс GRAM',
      subscriptionExpiresAt: 'дата окончания подписки',
    };

    const hint = field === 'subscriptionExpiresAt'
      ? '\n(формат: `ГГГГ-ММ-ДД` или `ГГГГ-ММ-ДД ЧЧ:ММ`)'
      : '';

    ctx.session.awaitingEditField = { userId, field };
    await ctx.reply(
      `✏️ Введите новое значение для поля **${fieldLabels[field] || field}**:${hint}\n` +
      `(отправьте /cancel для отмены)`,
      { parse_mode: 'Markdown' },
    );
  }

  @Action(/^er_(admin|user)_(\d+)$/)
  async onSetRole(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const newRole = match[1];
    const userId = parseInt(match[2], 10);

    const user = await this.userService.findById(userId);
    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    await this.userService.update(userId, { role: newRole });
    await ctx.reply(`✅ Роль изменена на **${newRole}**.`, { parse_mode: 'Markdown' });
    await this.botService.showUserEditFields(ctx, (await this.userService.findById(userId))!);
  }

  @Action(/^ea_(true|false)_(\d+)$/)
  async onSetActive(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const newActive = match[1] === 'true';
    const userId = parseInt(match[2], 10);

    const user = await this.userService.findById(userId);
    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    await this.userService.update(userId, { userIsActive: newActive });
    const status = newActive ? 'активирован' : 'деактивирован';
    await ctx.reply(`✅ Пользователь **${status}**.`, { parse_mode: 'Markdown' });

    if (newActive) {
      await this.botService.sendActivationNotificationToUser(ctx, user.telegramId);
    }

    await this.botService.showUserEditFields(ctx, (await this.userService.findById(userId))!);
  }

  /** Admin: add 7 days to user subscription */
  @Action(/^subadd_(\d+)$/)
  async onSubAdd(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const userId = parseInt(match[1], 10);
    const user = await this.userService.findById(userId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    // Create a new 7-day key
    const result = await this.botService.provisionKey(user, 168);
    if (result) {
      await ctx.reply(
        `📅 Ключ **Key${result.key.keyIndex}** создан до **${this.botService.formatMskDate(result.key.subscriptionExpiresAt!)}**`,
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply('❌ Не удалось создать ключ.');
    }
    await this.botService.showUserEditFields(ctx, (await this.userService.findById(userId))!);
  }

  /** Open subscription management for a user (admin) */
  @Action(/^submgmt_(\d+)$/)
  async onSubMgmt(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const userId = parseInt(match[1], 10);
    const user = await this.userService.findById(userId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    await this.botService.showSubscriptionManagement(ctx, user);
  }

  /** Toggle HideFox VPN client enable/disable (admin) */
  @Action(/^togclient_(\d+)_(enable|disable)$/)
  async onToggleClient(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const userId = parseInt(match[1], 10);
    const action = match[2] as 'enable' | 'disable';

    const ok = await this.botService.toggleClient(userId, action === 'enable');
    const user = await this.userService.findById(userId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    if (ok) {
      const label = action === 'enable' ? 'включён' : 'отключён';
      await ctx.answerCbQuery(`✅ Клиент ${label}`);
    } else {
      await ctx.answerCbQuery('❌ Не удалось изменить состояние клиента');
    }

    await this.botService.showSubscriptionManagement(ctx, user);
  }

  @Action(/^cancel_edit/)
  async onCancelEdit(@Ctx() ctx: Context & { session: SessionData }) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    ctx.session.awaitingEditField = undefined;
    await this.botService.showEditUsersList(ctx);
  }

  // ─── Delete user (with confirmation) ─────────────────────────

  @Action(/^del_(\d+)$/)
  async onDeleteUser(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const userId = parseInt(match[1], 10);
    const user = await this.userService.findById(userId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    const name = user.firstName || user.username || `ID ${user.telegramId}`;
    await ctx.reply(
      `⚠️ **Удалить пользователя?**\n\n${name}\nTelegram ID: \`${user.telegramId}\`\n\nЭто действие необратимо!`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Да, удалить', `delyes_${userId}`),
            Markup.button.callback('❌ Нет', `delno_${userId}`),
          ],
        ]),
      },
    );
  }

  @Action(/^delyes_(\d+)$/)
  async onDeleteConfirm(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const userId = parseInt(match[1], 10);
    const user = await this.userService.findById(userId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден (возможно, уже удалён).');
      return;
    }

    const name = user.firstName || user.username || `ID ${user.telegramId}`;
    await this.userService.delete(userId);
    await ctx.reply(`🗑 Пользователь **${name}** удалён.`, { parse_mode: 'Markdown' });
    await this.botService.showEditUsersList(ctx);
  }

  @Action(/^delno_(\d+)$/)
  async onDeleteCancel(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const userId = parseInt(match[1], 10);
    const user = await this.userService.findById(userId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    await this.botService.showUserEditFields(ctx, user);
  }

  // ─── Text handler ────────────────────────────────────────────

  @On('text')
  async onMessage(@Ctx() ctx: Context & { session: SessionData }) {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text;

      // ── /cancel during edit ────────────────────────────────
      if (text === '/cancel' && ctx.session?.awaitingEditField) {
        ctx.session.awaitingEditField = undefined;
        await ctx.reply('❌ Редактирование отменено.');
        return;
      }

      // ── /cancel during deposit flow ────────────────────────
      if (text === '/cancel' && ctx.session?.depositFlow) {
        ctx.session.depositFlow = undefined;
        await this.botService.showTopUpBalance(ctx);
        return;
      }

      // ── /cancel during ticket flow ─────────────────────────
      if (text === '/cancel' && ctx.session?.ticketFlow) {
        ctx.session.ticketFlow = undefined;
        await ctx.reply('❌ Создание тикета отменено.');
        return;
      }

      // ── Ticket flow: topic → message ───────────────────────
      if (ctx.session?.ticketFlow?.step === 'topic') {
        const topic = text.trim();
        const tMin = parseInt(process.env.TICKET_TOPIC_MIN || '3', 10);
        const tMax = parseInt(process.env.TICKET_TOPIC_MAX || '10', 10);
        if (topic.length < tMin || topic.length > tMax) {
          await ctx.reply(`❌ Тема должна быть от ${tMin} до ${tMax} символов. Попробуйте ещё раз:`);
          return;
        }
        ctx.session.ticketFlow.topic = topic;
        ctx.session.ticketFlow.step = 'message';
        await ctx.reply('📝 Введите **сообщение** обращения:', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отменить', 'cancel_action')],
          ]),
        });
        return;
      }

      if (ctx.session?.ticketFlow?.step === 'message') {
        const msg = text.trim();
        const mMin = parseInt(process.env.TICKET_MSG_MIN || '10', 10);
        const mMax = parseInt(process.env.TICKET_MSG_MAX || '150', 10);
        if (msg.length < mMin || msg.length > mMax) {
          await ctx.reply(`❌ Сообщение должно быть от ${mMin} до ${mMax} символов. Попробуйте ещё раз:`);
          return;
        }
        await this.handleTicketCreate(ctx, ctx.session.ticketFlow!.topic!, msg);
        ctx.session.ticketFlow = undefined;
        return;
      }

      // ── Admin/User ticket action (reply/close) ─────────────
      if (ctx.session?.ticketAdmin) {
        const { ticketId, action } = ctx.session.ticketAdmin;
        ctx.session.ticketAdmin = undefined;
        const input = text.trim();
        const tgUser = ctx.from!;

        if (action === 'reply') {
          const reply = {
            userId: tgUser.id,
            userName: tgUser.first_name || tgUser.username || `ID ${tgUser.id}`,
            message: input,
            createdAt: new Date().toISOString(),
          };

          const updated = await this.ticketService.addReply(ticketId, reply);
          if (updated) {
            await ctx.reply('✅ Ответ добавлен.');
            // Notify the other party
            const notifyId = updated.userId === tgUser.id
              ? (this.botService.getSupportIds().find(() => true) || updated.userId)
              : updated.userId;
            try {
              await ctx.telegram.sendMessage(
                notifyId,
                `📩 **Новый ответ в тикете #${updated.id}**\n\n` +
                `📌 Тема: ${updated.topic}\n` +
                `👤 ${reply.userName}: ${reply.message}`,
                {
                  parse_mode: 'Markdown',
                  ...Markup.inlineKeyboard([
                    [Markup.button.callback('📝 Ответить', `user_reply_ticket_${updated.id}`)],
                  ]),
                },
              );
            } catch (_) {}
          }

          // Return to appropriate view
          if (this.isAdminOrSupport(ctx)) {
            await this.showTicketInfo(ctx, ticketId);
          } else {
            await this.showSupportMenu(ctx);
          }
        } else if (action === 'close') {
          const closed = await this.ticketService.close(ticketId);
          if (closed) {
            await ctx.reply('🔴 Тикет закрыт.');
            try {
              await ctx.telegram.sendMessage(
                closed.userId,
                `🔴 **Тикет #${closed.id} закрыт**\n\n` +
                `📌 Тема: ${closed.topic}\n` +
                `💬 Сообщение от поддержки: ${input}`,
                { parse_mode: 'Markdown' },
              );
            } catch (_) {}
          }
          await this.showAdminTickets(ctx);
        }
        return;
      }

      // ── Deposit TxID input ──────────────────────────────────
      if (ctx.session?.depositFlow?.step === 'txid') {
        await this.handleDepositTxId(ctx, text);
        return;
      }

      // ── Inactive user guard ────────────────────────────────
      if (!(await this.checkActive(ctx))) return;

      // ── Awaiting edit field input ───────────────────────────
      if (ctx.session?.awaitingEditField) {
        await this.handleEditFieldInput(ctx, text);
        return;
      }

      // ── Route /seeusers manually ────────────────────────────
      if (text.trim().match(/^\/seeusers(@\w+)?$/)) {
        await this.handleSeeUsers(ctx);
        return;
      }

      // ── Skip other commands ─────────────────────────────────
      if (text.startsWith('/')) {
        return;
      }

      // ── Skip keyboard button texts (handled by @Hears) ─────
      const keyboardButtons = ['🔌 Подключить VPN', '👤 Профиль', '🎁 Реферальная программа', 'ℹ️ Информация'];
      if (keyboardButtons.includes(text)) {
        return;
      }

      // ── Echo for regular text (respect ENABLE_AUTO_ANSWER) ──
      if (process.env.ENABLE_AUTO_ANSWER !== 'false') {
        const replyText = this.botService.processText(text);
        await ctx.reply(replyText);
      }
    }
  }

  // ─── /seeusers handlers ──────────────────────────────────────

  @Command('seeusers')
  async onSeeUsers(@Ctx() ctx: Context) {
    await this.handleSeeUsers(ctx);
  }

  @Action('seeusers')
  async onSeeUsersAction(@Ctx() ctx: Context) {
    if (!this.checkActionSpam(ctx)) { await ctx.answerCbQuery().catch(() => {}); return; }
    await ctx.answerCbQuery();
    await this.handleSeeUsers(ctx);
  }

  // ─── Private helpers ─────────────────────────────────────────

  /** Generate a random math CAPTCHA and send it to the user */
  private async sendCaptcha(ctx: Context, user: User) {
    const a = Math.floor(Math.random() * 20) + 1;
    const b = Math.floor(Math.random() * 20) + 1;
    const correctAnswer = a + b;

    (ctx as any).session.captchaPending = { answer: correctAnswer, user };

    const variants = new Set<number>();
    variants.add(correctAnswer);
    while (variants.size < 4) {
      const offset = (Math.floor(Math.random() * 10) - 5) || 1;
      const wrong = correctAnswer + offset;
      if (wrong >= 0 && wrong <= 100) {
        variants.add(wrong);
      }
    }

    const shuffled = [...variants].sort(() => Math.random() - 0.5);

    const buttons = shuffled.map((val) =>
      [Markup.button.callback(`${val}`, `captcha_${val}`)],
    );

    await ctx.reply(
      `🤖 **Проверка на бота**\n\nРеши пример: **${a} + ${b} = ?**`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) },
    );
  }

  /** Shared logic for listing users (admin-only) */
  private async handleSeeUsers(ctx: Context) {
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
      const role = u.role === 'admin' ? '👑 admin' : '👤 user';
      const name = u.firstName || '—';
      const username = u.username ? `@${u.username}` : '—';
      const lang = u.languageCode || '—';
      const premium = u.isPremium ? '⭐' : '';
      const active = u.userIsActive ? '✅' : '⏳';
      const blocked = u.userIsBlocked ? ' 🚫' : '';
      const created = u.createdAt?.toISOString().replace('T', ' ').slice(0, 19) || '—';
      return `${i + 1}. ${role}${premium} **${name}** (${username})${blocked}\n` +
        `   ID: \`${u.telegramId}\` | ${lang} | ${created}\n` +
        `   💰 ${u.userBalanceUSDT} USDT / ${u.userBalanceBTC} BTC / ${u.userBalanceGram} GRAM | ${active} ${u.userIsActive ? 'Активен' : 'Ожидает'}`;
    });

    const message = `📋 **Список пользователей** (${users.length}):\n\n${lines.join('\n\n')}`;
    await ctx.reply(message, { parse_mode: 'Markdown' });
  }

  /** Process deposit TxID + amount input */
  private async handleDepositTxId(ctx: Context & { session: SessionData }, text: string) {
    const tgUser = ctx.from!;
    const currency = ctx.session.depositFlow!.currency!;

    const txId = text.trim();
    if (!txId || txId.length < 4) {
      await ctx.reply('❌ Введите корректный TxID транзакции.');
      return;
    }

    // Check duplicate TxID
    const existing = await this.depositService.findByTxId(txId);
    if (existing) {
      ctx.session.depositFlow = undefined;
      await ctx.reply('❌ Эта транзакция уже была использована.');
      return;
    }

    // For BTC: verify against blockchain, get amount from chain
    if (currency === 'BTC') {
      await ctx.reply('🔍 Проверяю транзакцию в блокчейне...');
      const result = await this.botService.verifyBtcDeposit(txId, 0); // amount=0: accept any

      if (!result.success) {
        ctx.session.depositFlow = undefined;
        await ctx.reply(`❌ ${result.error}`);
        return;
      }

      ctx.session.depositFlow = undefined;
      const dbUser = await this.userService.findByTelegramId(tgUser.id);

      // Convert BTC to USDT
      const usdtAmount = await this.botService.convertToUsdt(result.verifiedAmount!, 'BTC');

      await this.depositService.create({
        userId: dbUser!.id,
        txId,
        currency,
        amount: result.verifiedAmount!,
        verifiedAmount: result.verifiedAmount!,
        status: 'confirmed',
      });
      await this.userService.creditBalance(dbUser!.id, 'USDT', usdtAmount);

      // Referral reward for BTC auto-confirm
      await this.botService.processReferralReward(dbUser!.id, usdtAmount);

      await ctx.reply(
        `✅ Пополнение подтверждено!\n` +
        `+**${result.verifiedAmount!.toFixed(8)} BTC** → **${usdtAmount.toFixed(2)} USDT** зачислено на баланс.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    // For USDT/GRAM: store as pending for admin review (amount TBD from blockchain)
    ctx.session.depositFlow = undefined;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    await this.depositService.create({
      userId: dbUser!.id,
      txId,
      currency,
      amount: 0, // will be updated by admin after verification
      status: 'pending',
    });

    await ctx.reply(
      `⏳ Пополнение **${currency}** отправлено на проверку администратору.\n` +
      `TxID: \`${txId}\`\n\n` +
      `Баланс будет зачислен после подтверждения.`,
      { parse_mode: 'Markdown' },
    );

    // Notify admins
    const admins = await this.userService.findAllAdmins();
    const name = dbUser!.firstName || dbUser!.username || `ID ${dbUser!.telegramId}`;
    for (const admin of admins) {
      try {
        await ctx.telegram.sendMessage(
          admin.telegramId,
          `💳 **Новое пополнение**\n👤 ${name}\n💰 ${currency}\n🔗 \`${txId}\``,
          { parse_mode: 'Markdown' },
        );
      } catch (_) {}
    }
  }

  /** Process edit field text input */
  private async handleEditFieldInput(ctx: Context & { session: SessionData }, text: string) {
    const { userId, field } = ctx.session.awaitingEditField!;

    // ── Ticket reply (before user lookup — userId is ticketId here) ──
    if (field === 'ticket_reply') {
      const ticketId = userId;
      const replyMsg = text.trim();
      const tgUser = ctx.from!;
      const reply = {
        userId: tgUser.id,
        userName: tgUser.first_name || tgUser.username || `ID ${tgUser.id}`,
        message: replyMsg,
        createdAt: new Date().toISOString(),
      };

      const updated = await this.ticketService.addReply(ticketId, reply);
      if (!updated) {
        await ctx.reply('❌ Тикет не найден.');
        ctx.session.awaitingEditField = undefined;
        return;
      }

      await ctx.reply('✅ Ответ добавлен.');

      try {
        await ctx.telegram.sendMessage(
          updated.userId,
          `📩 **Новый ответ в тикете #${updated.id}**\n\n` +
          `📌 Тема: ${updated.topic}\n` +
          `👤 ${reply.userName}: ${reply.message}`,
          { parse_mode: 'Markdown' },
        );
      } catch (_) {}

      ctx.session.awaitingEditField = undefined;
      // Redirect back to admin tickets list
      await this.showAdminTickets(ctx);
      return;
    }

    const user = await this.userService.findById(userId);

    if (!user) {
      ctx.session.awaitingEditField = undefined;
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    // ── Subscription date: redirect to key management ──
    // ── Set referrer code ────────────────────────────────
    if (field === 'referrer_code') {
      const code = text.trim().toUpperCase();
      const referrer = await this.userService.findByReferralCode(code);
      if (!referrer) {
        await ctx.reply('❌ Реферальный код не найден. Проверьте и попробуйте снова.');
        return;
      }
      if (referrer.telegramId === userId) {
        await ctx.reply('❌ Нельзя указать самого себя.');
        return;
      }
      await this.userService.setReferrer(userId, referrer.telegramId);
      ctx.session.awaitingEditField = undefined;
      await ctx.reply('✅ Реферальный код принят!');
      await this.showReferralInfo(ctx);
      return;
    }

    if (field === 'subscriptionExpiresAt') {
      await ctx.reply(
        'ℹ️ Для управления подпиской используйте **⚙️ Управление подпиской** в карточке пользователя.',
        { parse_mode: 'Markdown' },
      );
      ctx.session.awaitingEditField = undefined;
      await this.botService.showUserEditFields(ctx, (await this.userService.findById(userId))!);
      return;
    }

    let value: string | number = text.trim();

    if (field === 'userBalanceUSDT' || field === 'userBalanceBTC' || field === 'userBalanceGram') {
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) {
        await ctx.reply('❌ Введите положительное число.');
        return;
      }
      value = num;
    }

    await this.userService.update(userId, { [field]: value } as any);
    ctx.session.awaitingEditField = undefined;

    await ctx.reply('✅ Значение обновлено.');
    await this.botService.showUserEditFields(ctx, (await this.userService.findById(userId))!);
  }

  /** Handle activate action from inline button */
  private async handleActivateUser(ctx: Context) {
    const tgUser = ctx.from;
    if (!tgUser) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }

    if (!this.userService.isAdmin(tgUser.id)) {
      await ctx.reply('⛔ Эта команда доступна только администраторам.');
      return;
    }

    const match = (ctx as any).match;
    const targetTelegramId = parseInt(match[1], 10);
    const targetUser = await this.userService.findByTelegramId(targetTelegramId);

    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    if (targetUser.userIsActive) {
      await ctx.reply('ℹ️ Пользователь уже активирован.');
      return;
    }

    await this.userService.update(targetUser.id, { userIsActive: true });
    const name = targetUser.firstName || targetUser.username || `${targetTelegramId}`;

    // Edit the notification message to remove action buttons
    try {
      await ctx.editMessageText(
        `✅ Пользователь **${name}** активирован!`,
        { parse_mode: 'Markdown' },
      );
    } catch (_) {
      await ctx.reply(
        `✅ Пользователь **${name}** активирован!`,
        { parse_mode: 'Markdown' },
      );
    }

    await this.botService.sendActivationNotificationToUser(ctx, targetTelegramId);
  }

  /** Rate-limit config/QR requests per-button: true = allowed, false = cooldown active */
  private checkConfigCooldown(ctx: Context, telegramId: number, action: string): boolean {
    const key = `${telegramId}:${action}`;
    const last = this.configCooldown.get(key);
    const now = Date.now();
    if (last && (now - last) < this.CONFIG_COOLDOWN_MS) {
      const remaining = Math.ceil((this.CONFIG_COOLDOWN_MS - (now - last)) / 1000);
      ctx.answerCbQuery(`⏳ Подождите ${remaining} сек.`).catch(() => {});
      return false;
    }
    this.configCooldown.set(key, now);
    return true;
  }

  /** Fire-and-forget answerCbQuery — dismiss spinner immediately, ignore errors */
  private safeAnswerCbQuery(ctx: Context) {
    ctx.answerCbQuery().catch(() => {});
  }

  /** Send a file directly to Telegram API using form-data, bypassing Telegraf */
  private async sendFileDirectly(
    method: 'sendDocument' | 'sendPhoto',
    chatId: number,
    buffer: Buffer,
    filename: string,
    caption: string,
  ) {
    const token = process.env.TG_API_KEY!;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(method === 'sendDocument' ? 'document' : 'photo', buffer, { filename });
    form.append('caption', caption);

    // getBuffer() returns a Buffer compatible with global fetch (unlike the stream)
    const body = form.getBuffer();
    const headers = form.getHeaders();

    await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body,
      headers,
    });
  }

  /** Check if current user is admin — reply error if not */
  private checkAdmin(ctx: Context): boolean {
    const tgUser = ctx.from;
    if (!tgUser) {
      ctx.reply('Не удалось определить пользователя.');
      return false;
    }
    if (!this.userService.isAdmin(tgUser.id)) {
      ctx.reply('⛔ Эта функция доступна только администраторам.');
      return false;
    }
    return true;
  }

  /** Check if current user has an active subscription — reply if not. */
  private async checkSubscription(ctx: Context): Promise<boolean> {
    const tgUser = ctx.from;
    if (!tgUser) return false;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser || !this.botService.hasActiveSubscription(dbUser)) {
      await ctx.reply('🔒 Эта функция доступна только с активной подпиской.\nПерейдите в раздел 🔌 Подключить VPN.');
      return false;
    }
    return true;
  }

  /** Check if current user is active — reply appropriate message if not.
   *  Returns true if user is active or not found in DB. */
  private async checkActive(ctx: Context): Promise<boolean> {
    const tgUser = ctx.from;
    if (!tgUser) {
      await ctx.reply('Не удалось определить пользователя.');
      return false;
    }
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) return true;
    if (dbUser.userIsBlocked) {
      await this.botService.sendBlockedMessage(ctx);
      return false;
    }
    if (!dbUser.userIsActive) {
      await this.botService.sendPendingActivationMessage(ctx);
      return false;
    }
    return true;
  }
}
