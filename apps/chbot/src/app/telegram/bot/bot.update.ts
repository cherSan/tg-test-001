import {Update, Start, Help, On, Hears, Ctx, Command, Action, Settings} from 'nestjs-telegraf';
import {Context, Markup} from 'telegraf';
import FormData from 'form-data';
import { BotService } from './bot.service';
import {QrCodeService} from "../../qr/qr.service";
import {UserService} from "../../db/user.service";
import {DepositService} from "../../db/deposit.service";
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
}

@Update()
export class BotUpdate {
  /** Cooldown per button: "telegramId:action" → last request timestamp */
  private readonly configCooldown = new Map<string, number>();
  private readonly CONFIG_COOLDOWN_MS = 30_000;

  constructor(
    private readonly botService: BotService,
    private readonly qr: QrCodeService,
    private readonly userService: UserService,
    private readonly depositService: DepositService,
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
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showAdminSettings(ctx);
  }

  @Action('autoact_on')
  async onAutoActOn(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    this.botService.autoActivate = true;
    await ctx.reply('🟢 Автоактивация **включена**.', { parse_mode: 'Markdown' });
    await this.botService.showAdminSettings(ctx);
  }

  @Action('autoact_off')
  async onAutoActOff(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    this.botService.autoActivate = false;
    await ctx.reply('🔴 Автоактивация **выключена**.', { parse_mode: 'Markdown' });
    await this.botService.showAdminSettings(ctx);
  }

  // ─── Show menu callback (back button) ──────────────────────

  @Action('show_menu')
  async onShowMenu(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    await this.botService.showMenu(ctx);
  }

  // ─── Notification actions (block / delete from notify) ─────

  /** Block user from admin notification or edit screen */
  @Action(/^block_(\d+)$/)
  async onBlockUser(@Ctx() ctx: Context) {
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
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) return;

    const hasSub = await this.botService.hasActiveSubscription(dbUser);
    if (hasSub) {
      await this.botService.showProfile(ctx);
    } else {
      await this.botService.showBuySubscription(ctx);
    }
  }

  @Hears('👤 Профиль')
  async onKeyboardProfile(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) return;

    const keys = await this.botService.getUserKeys(dbUser.id);
    const activeKeys = keys.filter((k) => k.subscriptionExpiresAt && new Date(k.subscriptionExpiresAt) > new Date());
    const balance = (dbUser.userBalanceUSDT ?? 0).toFixed(2);

    if (activeKeys.length > 0) {
      // Has active keys → show subscription page
      await this.botService.showMySubscription(ctx, dbUser);
    } else {
      // No active keys → show info + action buttons
      const message =
        `Уважаемый пользователь, у Вас сейчас нет действующих ключей, но Вы можете их оформить.\n\n` +
        `💰 Ваш баланс: **${balance}** USDT\n\n` +
        `Если Вы считаете, что это ошибка, для связи с поддержкой используйте Ваш ID: \`${tgUser.id}\``;

      await ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔌 Оформить подписку', 'buy')],
          [Markup.button.callback('💳 Пополнить баланс', 'top_up')],
          [Markup.button.callback('🎁 Подарить подписку', 'gift_sub')],
          [Markup.button.callback('👥 Пригласить друга', 'invite_friend')],
        ]),
      });
    }
  }

  @Action('invite_friend')
  async onInviteFriend(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    await ctx.reply(
      '👥 **Пригласить друга**\n\n' +
      'Пригласите друга и получите бонусы!\n\n' +
      '🚧 Раздел в разработке.',
      { parse_mode: 'Markdown' },
    );
  }

  @Action('gift_sub')
  async onGiftSub(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    await ctx.reply(
      '🎁 **Подарить подписку**\n\n' +
      'Вы можете подарить подписку другому пользователю.\n\n' +
      '🚧 Раздел в разработке.',
      { parse_mode: 'Markdown' },
    );
  }

  @Hears('🎁 Реферальная программа')
  async onKeyboardReferral(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    await ctx.reply(
      '🏆 **Реферальная программа**\n\n' +
      'Пригласите друга и получите бонусы!\n\n' +
      '🚧 Раздел в разработке.',
      { parse_mode: 'Markdown' },
    );
  }

  @Hears('ℹ️ Информация')
  async onKeyboardInfo(@Ctx() ctx: Context) {
    if (!(await this.checkActive(ctx))) return;
    await ctx.reply(
      'ℹ️ **Информация**\n\n' +
      '🔐 Сервис AmneziaWG VPN\n' +
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
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    await this.botService.showBuySubscription(ctx);
  }

  /** User selected a plan to buy with balance */
  @Action(/^buyplan_(\d+)$/)
  async onBuyPlan(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    const match = (ctx as any).match;
    const hours = parseInt(match[1], 10);
    await this.botService.purchaseSubscriptionWithBalance(ctx, hours);
  }

  /** Show top-up page with payment addresses */
  @Action('top_up')
  async onTopUp(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    await this.botService.showTopUpBalance(ctx);
  }

  // ─── Deposit flow ──────────────────────────────────────────

  @Action('i_paid')
  async onIPaid(@Ctx() ctx: Context & { session: SessionData }) {
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;

    ctx.session.depositFlow = { step: 'currency' };
    await this.botService.showDepositCurrencySelect(ctx);
  }

  @Action(/^dep_currency_(BTC|USDT|GRAM)$/)
  async onDepositCurrency(@Ctx() ctx: Context & { session: SessionData }) {
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
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showPendingDeposits(ctx);
  }

  @Action(/^confdep_(\d+)$/)
  async onConfirmDeposit(@Ctx() ctx: Context) {
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
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    if (!(await this.checkSubscription(ctx))) return;
    await this.botService.showProfile(ctx);
  }

  /** Show list of keys for config */
  @Action('vpn_keys')
  async onVpnKeys(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    if (!(await this.checkSubscription(ctx))) return;
    await this.botService.showVpnKeys(ctx);
  }

  /** Show actions for a specific key */
  @Action(/^keycfg_(\d+)$/)
  async onKeyConfig(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    if (!(await this.checkSubscription(ctx))) return;

    const match = (ctx as any).match;
    const keyId = parseInt(match[1], 10);
    await this.botService.showKeyActions(ctx, keyId);
  }

  @Action(/^getlink_(\d+)$/)
  async onGetLink(@Ctx() ctx: Context & { session: SessionData }) {
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
      `🔐 Key${key.keyIndex} — конфигурация AmneziaWG`,
    );
  }

  @Action(/^getqr_(\d+)$/)
  async onGetQR(@Ctx() ctx: Context & { session: SessionData }) {
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

  @Action(/^otlink_(\d+)$/)
  async onOneTimeLink(@Ctx() ctx: Context & { session: SessionData }) {
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
    await ctx.answerCbQuery();
    if (!(await this.checkActive(ctx))) return;
    await (ctx as any).scene.enter(WIZARD_SCENE_ID);
  }

  @Action('scene_test')
  async sceneTest(@Ctx() ctx: Context): Promise<void> {
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
    await ctx.answerCbQuery();
    await this.handleActivateUser(ctx);
  }

  /** Show users awaiting activation (admin) */
  @Action('pending_users')
  async onPendingUsers(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showPendingUsers(ctx);
  }

  // ─── Edit Users actions ──────────────────────────────────────

  @Action('edit_users')
  async onEditUsers(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;
    await this.botService.showEditUsersList(ctx);
  }

  @Action(/^edit_user_(\d+)$/)
  async onEditUser(@Ctx() ctx: Context) {
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
    await ctx.answerCbQuery();
    if (!this.checkAdmin(ctx)) return;

    const match = (ctx as any).match;
    const userId = parseInt(match[1], 10);
    const user = await this.userService.findById(userId);

    if (!user) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    const now = new Date();
    const base = user.subscriptionExpiresAt && user.subscriptionExpiresAt > now
      ? new Date(user.subscriptionExpiresAt)
      : now;
    const newExpiry = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);

    await this.userService.update(userId, { subscriptionExpiresAt: newExpiry });

    // Provision VPN if not already done
    if (!user.amneziaPeerId) {
      await this.botService.provisionVpnForUser(userId);
    }

    await ctx.reply(
      `📅 Подписка продлена до **${newExpiry.toISOString().replace('T', ' ').slice(0, 19)}**`,
      { parse_mode: 'Markdown' },
    );
    await this.botService.showUserEditFields(ctx, (await this.userService.findById(userId))!);
  }

  /** Open subscription management for a user (admin) */
  @Action(/^submgmt_(\d+)$/)
  async onSubMgmt(@Ctx() ctx: Context) {
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

  /** Toggle AmneziaWG client enable/disable (admin) */
  @Action(/^togclient_(\d+)_(enable|disable)$/)
  async onToggleClient(@Ctx() ctx: Context) {
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
    await ctx.answerCbQuery();
    ctx.session.awaitingEditField = undefined;
    await this.botService.showEditUsersList(ctx);
  }

  // ─── Delete user (with confirmation) ─────────────────────────

  @Action(/^del_(\d+)$/)
  async onDeleteUser(@Ctx() ctx: Context) {
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
        await ctx.reply('❌ Пополнение отменено.');
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

      // ── Echo for regular text ───────────────────────────────
      const replyText = this.botService.processText(text);
      await ctx.reply(replyText);
    }
  }

  // ─── /seeusers handlers ──────────────────────────────────────

  @Command('seeusers')
  async onSeeUsers(@Ctx() ctx: Context) {
    await this.handleSeeUsers(ctx);
  }

  @Action('seeusers')
  async onSeeUsersAction(@Ctx() ctx: Context) {
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
    const user = await this.userService.findById(userId);

    if (!user) {
      ctx.session.awaitingEditField = undefined;
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    // ── Subscription date: redirect to key management ──
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
      await ctx.reply('🔒 Эта функция доступна только с активной подпиской.\nОформите подписку через 🔌 Оформить подписку.');
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
