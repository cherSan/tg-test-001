import { Injectable, Logger } from '@nestjs/common';
import {Context, Markup} from "telegraf";
import { UserService } from '../../db/user.service';
import { User } from '../../db/entities/user.entity';
import { DepositService } from '../../db/deposit.service';
import { Deposit } from '../../db/entities/deposit.entity';
import { AmneziaService } from '../../amnezia/amnezia.service';

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  /** Auto-activate users after CAPTCHA (can be toggled in admin settings) */
  autoActivate: boolean = process.env.AUTO_ACTIVATE === 'true';

  constructor(
    private readonly userService: UserService,
    private readonly depositService: DepositService,
    private readonly amneziaService: AmneziaService,
  ) {}

  getWelcomeMessage(username: string): string {
    return `Привет, ${username}! Рад приветствовать тебя!.`;
  }

  processText(text: string): string {
    return `Вы написали: "${text}". Я получил ваше сообщение.`;
  }

  async showMenu(ctx: Context) {
    const tgUser = ctx.from;
    const isAdmin = tgUser ? this.userService.isAdmin(tgUser.id) : false;

    // Check subscription for feature gating
    const dbUser = tgUser ? await this.userService.findByTelegramId(tgUser.id) : null;
    const hasSub = dbUser ? this.hasActiveSubscription(dbUser) : false;

    const buttons: any[][] = [
      [
        Markup.button.url('Читать правила', 'https://telegram.org'),
      ],
      [
        Markup.button.callback('💰 Баланс', 'balance'),
        Markup.button.callback('💳 Пополнить баланс', 'top_up'),
      ],
      [
        Markup.button.callback('📋 Мои подписки', 'my_subscription'),
      ],
    ];

    buttons.push([
      Markup.button.callback('Тест визарда', 'wizard_test'),
      Markup.button.callback('Тест сцены', 'scene_test'),
    ]);

    if (isAdmin) {
      buttons.push([Markup.button.callback('👥 Пользователи', 'seeusers')]);
      buttons.push([Markup.button.callback('⏳ Ожидают активации', 'pending_users')]);
      buttons.push([Markup.button.callback('💳 Ожидают пополнения', 'pending_deposits')]);
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

  /** Show user's balances */
  async showUserBalance(ctx: Context, user: User) {
    const usdt = user.userBalanceUSDT?.toFixed(2) || '0.00';
    const btc = user.userBalanceBTC?.toFixed(8) || '0.00000000';
    const gram = user.userBalanceGram?.toFixed(2) || '0.00';

    const hasBalance = (user.userBalanceUSDT ?? 0) > 0
                    || (user.userBalanceBTC ?? 0) > 0
                    || (user.userBalanceGram ?? 0) > 0;

    const message =
      `💰 **Ваш баланс**\n\n` +
      `💵 USDT: **${usdt}**\n` +
      `₿  BTC: **${btc}**\n` +
      `💎 GRAM: **${gram}**`;

    const buttons: any[][] = [];
    if (hasBalance) {
      buttons.push([Markup.button.callback('💳 Купить подписку', 'buy')]);
    }
    buttons.push([Markup.button.callback('💳 Пополнить баланс', 'top_up')]);
    buttons.push([Markup.button.callback('🔙 Назад', 'show_menu')]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Check if user has an active (non-expired) subscription */
  hasActiveSubscription(user: User): boolean {
    if (!user.subscriptionExpiresAt) return false;
    return new Date(user.subscriptionExpiresAt) > new Date();
  }

  /** Show user's current subscription status */
  async showMySubscription(ctx: Context, user: User) {
    const hasSub = this.hasActiveSubscription(user);
    const expires = user.subscriptionExpiresAt
      ? new Date(user.subscriptionExpiresAt).toISOString().replace('T', ' ').slice(0, 19)
      : null;

    const buyLabel = hasSub ? '💳 Продлить подписку' : '💳 Купить подписку';
    let message: string;
    if (hasSub && expires) {
      const now = new Date();
      const expDate = new Date(user.subscriptionExpiresAt!);
      const daysLeft = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      message =
        `📋 **Мои подписки**\n\n` +
        `✅ Подписка активна\n` +
        `📅 Истекает: ${expires}\n` +
        `⏳ Осталось дней: **${daysLeft}**`;
    } else if (expires) {
      message =
        `📋 **Мои подписки**\n\n` +
        `❌ Подписка истекла\n` +
        `📅 Истекла: ${expires}`;
    } else {
      message =
        `📋 **Мои подписки**\n\n` +
        `❌ Нет активных подписок`;
    }

    const buttons: any[][] = [
      [Markup.button.callback(buyLabel, 'buy')],
      [Markup.button.callback('💳 Пополнить баланс', 'top_up')],
    ];

    // Show VPN config button only if user has active subscription
    if (hasSub) {
      buttons.push([Markup.button.callback('🔐 Конфигурации VPN', 'vpn_config')]);
    }

    buttons.push([Markup.button.callback('🔙 Назад', 'show_menu')]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Fetch live BTC/USDT and GRAM/USDT rates from configured exchange */
  async fetchCoinExRates(): Promise<{ btcUsdt: number; tonUsdt: number; exchange: string }> {
    const exchange = (process.env.EXCHANGE_API || 'coinex').toLowerCase();

    try {
      if (exchange === 'binance') {
        const [btcRes, tonRes] = await Promise.all([
          fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
          fetch('https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT'),
        ]);
        const btcData = await btcRes.json() as any;
        const tonData = await tonRes.json() as any;
        return {
          btcUsdt: parseFloat(btcData?.price) || 0,
          tonUsdt: parseFloat(tonData?.price) || 0,
          exchange: 'Binance',
        };
      }

      // Default: CoinEx v1
      const [btcRes, gramRes] = await Promise.all([
        fetch('https://api.coinex.com/v1/market/ticker?market=BTCUSDT'),
        fetch('https://api.coinex.com/v1/market/ticker?market=GRAMUSDT'),
      ]);
      const btcData = await btcRes.json() as any;
      const gramData = await gramRes.json() as any;
      return {
        btcUsdt: parseFloat(btcData?.data?.ticker?.last) || 0,
        tonUsdt: parseFloat(gramData?.data?.ticker?.last) || 0,
        exchange: 'CoinEx',
      };
    } catch {
      return { btcUsdt: 0, tonUsdt: 0, exchange: exchange };
    }
  }

  /** Calculate subscription plan prices from env */
  getSubscriptionPlans(rates: { btcUsdt: number; tonUsdt: number }) {
    const plans = [
      { label: '🆓 Пробный', hours: 24, usdt: parseFloat(process.env.SUBSCRIPTION_24H_USDT || '0') },
      { label: '📅 7 дней', hours: 168, usdt: parseFloat(process.env.SUBSCRIPTION_7D_USDT || '5') },
      { label: '📅 14 дней', hours: 336, usdt: parseFloat(process.env.SUBSCRIPTION_14D_USDT || '13.5') },
      { label: '📅 1 месяц', hours: 720, usdt: parseFloat(process.env.SUBSCRIPTION_30D_USDT || '22.5') },
      { label: '📅 6 месяцев', hours: 4320, usdt: parseFloat(process.env.SUBSCRIPTION_180D_USDT || '90') },
    ];

    return plans.map((p) => {
      const btc = rates.btcUsdt > 0 ? +(p.usdt / rates.btcUsdt).toFixed(8) : null;
      const gram = rates.tonUsdt > 0 ? +(p.usdt / rates.tonUsdt).toFixed(2) : null;
      return { ...p, btc, gram };
    });
  }

  /** Show "buy with balance" — plans with inline buttons */
  async showBuySubscription(ctx: Context) {
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    const balance = dbUser?.userBalanceUSDT ?? 0;

    const rates = await this.fetchCoinExRates();
    const plans = this.getSubscriptionPlans(rates);

    // Build plans table
    let plansText = '';
    for (const p of plans) {
      const btcStr = p.btc !== null ? `~${p.btc} BTC` : '';
      const gramStr = p.gram !== null ? `~${p.gram} GRAM` : '';
      const altStr = [btcStr, gramStr].filter(Boolean).join(' / ');
      if (p.usdt === 0) {
        plansText += `${p.label}: **Бесплатно**\n`;
      } else {
        plansText += `${p.label}: **${p.usdt}** USDT${altStr ? ` (${altStr})` : ''}\n`;
      }
    }

    const message =
      `💳 **Покупка подписки**\n\n` +
      `Тарифы:\n${plansText}\n` +
      `💰 Ваш баланс: **${balance.toFixed(2)}** USDT\n\n` +
      `Выберите тариф (средства спишутся с баланса):`;

    // Build plan buttons
    const planButtons: any[][] = plans.map((p) => {
      const label = p.usdt === 0
        ? `${p.label} — Бесплатно`
        : `${p.label} — ${p.usdt} USDT`;
      return [Markup.button.callback(label, `buyplan_${p.hours}`)];
    });

    planButtons.push([Markup.button.callback('🔙 Назад', 'my_subscription')]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(planButtons),
    });
  }

  /** Show top-up page with payment addresses */
  async showTopUpBalance(ctx: Context) {
    const usdtAddr = process.env.USDT_PAYMENT_ADDRESS || 'не задан';
    const btcAddr = process.env.BTC_PAYMENT_ADDRESS || 'не задан';
    const gramAddr = process.env.GRAM_PAYMENT_ADDRESS || 'не задан';

    const message =
      `💳 **Пополнение баланса**\n\n` +
      `Отправьте криптовалюту на один из адресов:\n\n` +
      `💵 USDT: \`${usdtAddr}\`\n` +
      `₿  BTC: \`${btcAddr}\`\n` +
      `💎 GRAM: \`${gramAddr}\`\n\n` +
      `После отправки нажмите «✅ Я оплатил» и укажите детали транзакции.`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Я оплатил', 'i_paid')],
        [Markup.button.callback('🔙 Назад', 'show_menu')],
      ]),
    });
  }

  /** Purchase a subscription plan with balance */
  async purchaseSubscriptionWithBalance(ctx: Context, planHours: number): Promise<boolean> {
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return false;
    }

    // Resolve plan price from env by hours
    const plans = this.getSubscriptionPlans({ btcUsdt: 0, tonUsdt: 0 });
    const plan = plans.find((p) => p.hours === planHours);
    if (!plan) {
      await ctx.reply('❌ Тариф не найден.');
      return false;
    }

    // Check balance (skip for free plans)
    if (plan.usdt > 0 && dbUser.userBalanceUSDT < plan.usdt) {
      await ctx.reply(
        `❌ Недостаточно средств!\n\n` +
        `Тариф: **${plan.usdt}** USDT\n` +
        `Ваш баланс: **${dbUser.userBalanceUSDT.toFixed(2)}** USDT\n\n` +
        `Пополните баланс через «💳 Пополнить баланс».`,
        { parse_mode: 'Markdown' },
      );
      return false;
    }

    // Deduct from balance
    if (plan.usdt > 0) {
      const newBalance = dbUser.userBalanceUSDT - plan.usdt;
      await this.userService.update(dbUser.id, { userBalanceUSDT: newBalance });
    }

    // Set subscription expiry
    const now = new Date();
    const base = dbUser.subscriptionExpiresAt && dbUser.subscriptionExpiresAt > now
      ? new Date(dbUser.subscriptionExpiresAt)
      : now;
    const newExpiry = new Date(base.getTime() + planHours * 3600 * 1000);

    await this.userService.update(dbUser.id, { subscriptionExpiresAt: newExpiry });

    // Provision VPN
    const provisioned = await this.provisionVpnForUser(dbUser.id);

    const expiryStr = this.formatMskDate(newExpiry);
    const vpnButton = Markup.inlineKeyboard([
      [Markup.button.callback('🔐 Конфигурации VPN', 'vpn_config')],
      [Markup.button.callback('🔙 В меню', 'show_menu')],
    ]);

    if (plan.usdt === 0) {
      if (provisioned) {
        await ctx.reply(
          `🎉 **${plan.label}** активирован!\n\n` +
          `✅ Подписка активна до **${expiryStr}**\n` +
          `🔐 VPN-аккаунт создан:`,
          { parse_mode: 'Markdown', ...vpnButton },
        );
      } else {
        await ctx.reply(
          `🎉 **${plan.label}** активирован!\n\n` +
          `✅ Подписка активна до **${expiryStr}**\n` +
          `⚠️ Не удалось создать VPN-аккаунт. Администратор решит проблему.`,
          { parse_mode: 'Markdown' },
        );
      }
    } else {
      if (provisioned) {
        await ctx.reply(
          `✅ Подписка **${plan.label}** оплачена с баланса!\n\n` +
          `💸 Списано: **${plan.usdt}** USDT\n` +
          `💰 Остаток: **${(dbUser.userBalanceUSDT - plan.usdt).toFixed(2)}** USDT\n` +
          `📅 Подписка активна до **${expiryStr}**\n` +
          `🔐 VPN-аккаунт создан:`,
          { parse_mode: 'Markdown', ...vpnButton },
        );
      } else {
        await ctx.reply(
          `✅ Подписка **${plan.label}** оплачена с баланса!\n\n` +
          `💸 Списано: **${plan.usdt}** USDT\n` +
          `💰 Остаток: **${(dbUser.userBalanceUSDT - plan.usdt).toFixed(2)}** USDT\n` +
          `📅 Подписка активна до **${expiryStr}**\n` +
          `⚠️ Не удалось создать VPN-аккаунт. Администратор решит проблему.`,
          { parse_mode: 'Markdown' },
        );
      }
    }

    return true;
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

    const peerInfo = user.amneziaPeerId
      ? `\n🔐 VPN пир: \`${user.amneziaPeerId.slice(0, 8)}...\``
      : '\n🔐 VPN пир: не создан';

    const info =
      `📝 **Редактирование пользователя**\n\n` +
      `${roleIcon} **${name}** (${username})\n` +
      `🆔 Telegram ID: \`${user.telegramId}\`\n` +
      `💼 Роль: ${user.role}\n` +
      `💰 Баланс: ${user.userBalanceUSDT} USDT / ${user.userBalanceBTC} BTC / ${user.userBalanceGram} GRAM\n` +
      `📌 Статус: ${activeStatus}\n` +
      `📋 Подписка: ${user.subscriptionExpiresAt ? 'до ' + this.formatMskDate(user.subscriptionExpiresAt!) : 'нет'}\n` +
      (blockedStatus ? `🚫 ${blockedStatus}\n` : '') +
      `📅 Создан: ${user.createdAt?.toISOString().replace('T', ' ').slice(0, 19) || '—'}${peerInfo}\n\n` +
      `Выберите поле для редактирования:`;

    const buttons: any[][] = [
      [
        Markup.button.callback('✏️ Имя', `ef_firstName_${user.id}`),
        Markup.button.callback('✏️ Username', `ef_username_${user.id}`),
      ],
      [
        Markup.button.callback('💵 USDT', `ef_userBalanceUSDT_${user.id}`),
        Markup.button.callback('₿ BTC', `ef_userBalanceBTC_${user.id}`),
        Markup.button.callback('💎 GRAM', `ef_userBalanceGram_${user.id}`),
      ],
      [
        Markup.button.callback('⚙️ Управление подпиской', `submgmt_${user.id}`),
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
        Markup.button.callback('📅 Подписка +7д', `subadd_${user.id}`),
        Markup.button.callback('🗑 Удалить', `del_${user.id}`),
        Markup.button.callback('🔙 К списку', 'edit_users'),
      ],
    ];

    await ctx.reply(info, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  // ─── MSK timezone helpers ─────────────────────────────────

  private readonly MSK_OFFSET_MS = 3 * 3600_000;

  /** Parse user-entered date string as MSK time, returns UTC Date */
  parseMskDate(text: string): Date | null {
    const clean = text.trim().replace(' ', 'T');
    // If no timezone specified, treat as MSK (+03:00)
    const withTz = clean.includes('+') || clean.includes('Z') || clean.endsWith('Z')
      ? clean
      : clean + '+03:00';
    const d = new Date(withTz);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Format a UTC Date as MSK string for display */
  formatMskDate(date: Date): string {
    const msk = new Date(date.getTime() + this.MSK_OFFSET_MS);
    return msk.toISOString().replace('T', ' ').slice(0, 19) + ' МСК';
  }

  // ─── Subscription management ───────────────────────────────

  /** Show subscription management page (admin) */
  async showSubscriptionManagement(ctx: Context, user: User) {
    const peerInfo = user.amneziaPeerId
      ? `🔐 VPN пир: \`${user.amneziaPeerId.slice(0, 8)}...\``
      : '🔐 VPN пир: не создан';
    const subInfo = user.subscriptionExpiresAt
      ? `📋 Подписка до: **${this.formatMskDate(user.subscriptionExpiresAt)}**`
      : '📋 Подписка: нет';

    // Fetch client status from AmneziaWG
    let clientEnabled = true;
    if (user.amneziaPeerId) {
      const clients = await this.amneziaService.listClients();
      const c = clients.find((c) => c.id === user.amneziaPeerId);
      clientEnabled = c?.enabled ?? true;
    }

    const statusText = user.amneziaPeerId
      ? (clientEnabled ? '🟢 Клиент активен' : '🔴 Клиент отключён')
      : '⚪ Клиент не создан';

    const toggleLabel = clientEnabled
      ? '🔴 Отключить клиента'
      : '🟢 Включить клиента';

    const message =
      `⚙️ **Управление подпиской**\n\n` +
      `${subInfo}\n` +
      `${peerInfo}\n` +
      `${statusText}\n\n` +
      `Действия:`;

    const buttons: any[][] = [];

    if (user.amneziaPeerId) {
      buttons.push([
        Markup.button.callback(toggleLabel, `togclient_${user.id}_${clientEnabled ? 'disable' : 'enable'}`),
      ]);
    }

    buttons.push([
      Markup.button.callback('✏️ Изменить время подписки', `ef_subscriptionExpiresAt_${user.id}`),
    ]);
    buttons.push([Markup.button.callback('🔙 Назад', `edit_user_${user.telegramId}`)]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Toggle AmneziaWG client enabled/disabled */
  async toggleClient(userId: number, enable: boolean): Promise<boolean> {
    const user = await this.userService.findById(userId);
    if (!user?.amneziaPeerId) return false;

    return enable
      ? this.amneziaService.enableClient(user.amneziaPeerId)
      : this.amneziaService.disableClient(user.amneziaPeerId);
  }

  /** Show VPN configuration page (download + QR + one-time link) */
  async showVpnConfig(ctx: Context) {
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    const message =
      `🔐 **Конфигурации VPN**\n\n` +
      `Выберите способ получения конфигурации:`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Скачать конфигурацию', 'get_link')],
        [Markup.button.callback('📱 Получить QRcode', 'get_qr')],
        [Markup.button.callback('🔗 Одноразовая ссылка', 'onetimelink')],
        [Markup.button.callback('🔙 Назад', 'my_subscription')],
      ]),
    });
  }

  // ─── Deposit / Payment verification ─────────────────────

  /** Ask user to select currency for deposit */
  async showDepositCurrencySelect(ctx: Context) {
    await ctx.reply(
      '✅ **Я оплатил**\n\nВыберите валюту пополнения:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('₿ BTC', 'dep_currency_BTC'),
            Markup.button.callback('💵 USDT', 'dep_currency_USDT'),
            Markup.button.callback('💎 GRAM', 'dep_currency_GRAM'),
          ],
          [Markup.button.callback('🔙 Отмена', 'show_menu')],
        ]),
      },
    );
  }

  /** Prompt user to enter TxID and amount */
  async showTxIdPrompt(ctx: Context, currency: string) {
    await ctx.reply(
      `📝 Введите **TxID** транзакции и **сумму** через пробел:\n\n` +
      `Пример: \`abc123def456... 0.005\`\n\n` +
      `Валюта: **${currency}**\n` +
      `(отправьте /cancel для отмены)`,
      { parse_mode: 'Markdown' },
    );
  }

  /** Verify BTC transaction against blockchain */
  async verifyBtcDeposit(txId: string, expectedAmount: number): Promise<{
    success: boolean;
    verifiedAmount?: number;
    error?: string;
  }> {
    const btcAddr = process.env.BTC_PAYMENT_ADDRESS || '';

    // Try mempool.space first
    try {
      const res = await fetch(`https://mempool.space/api/tx/${txId}`);
      if (!res.ok) {
        return { success: false, error: 'Транзакция не найдена в блокчейне.' };
      }
      const tx = await res.json() as any;
      if (!tx.status?.confirmed) {
        return { success: false, error: 'Транзакция ещё не подтверждена. Попробуйте позже.' };
      }

      let totalToUs = 0;
      for (const out of tx.vout || []) {
        if (out.scriptpubkey_address === btcAddr) {
          totalToUs += out.value / 100_000_000; // satoshi → BTC
        }
      }

      if (totalToUs === 0) {
        return { success: false, error: `Адрес получателя не совпадает с BTC_PAYMENT_ADDRESS.` };
      }

      if (Math.abs(totalToUs - expectedAmount) > 0.0001) {
        return {
          success: false,
          error: `Сумма не совпадает. Ожидалось: ${expectedAmount} BTC, найдено: ${totalToUs.toFixed(8)} BTC.`,
        };
      }

      return { success: true, verifiedAmount: totalToUs };
    } catch {
      return { success: false, error: 'Не удалось проверить транзакцию. Попробуйте позже.' };
    }
  }

  /** Show deposit history to user */
  async showMyDeposits(ctx: Context, deposits: Deposit[]) {
    if (deposits.length === 0) {
      await ctx.reply('📭 У вас пока нет пополнений.');
      return;
    }

    const lines = deposits.map((d) => {
      const statusIcon = d.status === 'confirmed' ? '✅' : d.status === 'rejected' ? '❌' : '⏳';
      return `${statusIcon} **${d.currency}** ${d.amount} | Tx: \`${d.txId.slice(0, 16)}...\` | ${d.createdAt.toISOString().replace('T', ' ').slice(0, 19)}`;
    });

    await ctx.reply(
      `📋 **История пополнений**\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' },
    );
  }

  /** Admin: show pending deposits */
  async showPendingDeposits(ctx: Context) {
    const deposits = await this.depositService.findPending();

    if (deposits.length === 0) {
      await ctx.reply('✅ Нет ожидающих пополнений.');
      return;
    }

    for (const d of deposits) {
      const user = await this.userService.findById(d.userId);
      const name = user?.firstName || user?.username || `ID ${d.userId}`;
      const message =
        `💳 **Пополнение #${d.id}**\n` +
        `👤 ${name}\n` +
        `💰 ${d.amount} ${d.currency}\n` +
        `🔗 TxID: \`${d.txId}\`\n` +
        `📅 ${d.createdAt.toISOString().replace('T', ' ').slice(0, 19)}`;

      await ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Подтвердить', `confdep_${d.id}`),
            Markup.button.callback('❌ Отклонить', `rejdep_${d.id}`),
          ],
        ]),
      });
    }
  }

  /** Generate one-time config link for user */
  async getOneTimeLink(peerId: string): Promise<string | null> {
    return this.amneziaService.getOneTimeLink(peerId);
  }

  /** Update subscription expiry — DB + AmneziaWG sync */
  async updateSubscription(
    userId: number,
    newExpiry: Date,
    oldUser: User,
  ): Promise<{ synced: boolean }> {
    await this.userService.update(userId, { subscriptionExpiresAt: newExpiry });

    // Sync with AmneziaWG if user has a peer
    let synced = false;
    if (oldUser.amneziaPeerId) {
      synced = await this.amneziaService.updateClientExpireDate(
        oldUser.amneziaPeerId,
        newExpiry.toISOString(),
      );
    }
    return { synced };
  }

  // ─── AmneziaWG VPN provisioning ────────────────────────────

  /** Ensure user has an AmneziaWG peer; create one and link it if not */
  async ensureUserHasPeer(user: User): Promise<string | null> {
    // Calculate remaining hours for AmneziaWG client expiry
    const expireHours = user.subscriptionExpiresAt
      ? Math.ceil((new Date(user.subscriptionExpiresAt).getTime() - Date.now()) / 3600_000)
      : undefined;

    // If existing peer, just fetch config (AmneziaWG expiry was set at creation)
    if (user.amneziaPeerId) {
      const config = await this.amneziaService.getClientConfig(user.amneziaPeerId);
      if (config) return config;
      // Peer might have been deleted on server — recreate
      this.logger.warn(`Client ${user.amneziaPeerId} not found on server, recreating...`);
    }

    // Create new peer with subscription-based expiry
    const clientName = user.firstName || user.username || `user_${user.telegramId}`;
    const client = await this.amneziaService.createClient(clientName, expireHours);
    if (!client) {
      this.logger.error(`Failed to create client for user ${user.telegramId}`);
      return null;
    }

    // Link client to user in DB
    await this.userService.update(user.id, { amneziaPeerId: client.id });

    // Fetch config for the newly created client
    return this.amneziaService.getClientConfig(client.id);
  }

  /** Provision VPN for a user after subscription activation */
  async provisionVpnForUser(userId: number): Promise<boolean> {
    const user = await this.userService.findById(userId);
    if (!user) return false;

    const config = await this.ensureUserHasPeer(user);
    if (!config) {
      this.logger.error(`VPN provisioning failed for user ${userId}`);
      return false;
    }

    this.logger.log(`VPN provisioned for user ${user.telegramId} (peer=${user.amneziaPeerId})`);
    return true;
  }

  /** Remove user's VPN peer (on subscription expiry or block) */
  async deprovisionVpnForUser(userId: number): Promise<boolean> {
    const user = await this.userService.findById(userId);
    if (!user?.amneziaPeerId) return false;

    const deleted = await this.amneziaService.deleteClient(user.amneziaPeerId);
    if (deleted) {
      await this.userService.update(userId, { amneziaPeerId: null });
      this.logger.log(`VPN deprovisioned for user ${user.telegramId}`);
    }
    return deleted;
  }

  async handlePreCheckoutQuery(ctx: Context) {
    await ctx.answerPreCheckoutQuery(true);
  }

  async handleSuccessfulPayment(userId: number, payload: string, ctx: Context) {
    this.logger.log(`User ${userId} paid, payload: ${payload}`);

    // payload format: "plan_hours" e.g. "168" for 7 days
    const hours = parseInt(payload, 10) || 0;
    if (hours <= 0) {
      await ctx.reply('🎉 Спасибо за оплату! Подписка активирована.');
      return;
    }

    const dbUser = await this.userService.findByTelegramId(userId);
    if (!dbUser) {
      await ctx.reply('🎉 Спасибо за оплату! Но ваш профиль не найден.');
      return;
    }

    const now = new Date();
    const base = dbUser.subscriptionExpiresAt && dbUser.subscriptionExpiresAt > now
      ? new Date(dbUser.subscriptionExpiresAt)
      : now;
    const newExpiry = new Date(base.getTime() + hours * 3600 * 1000);

    await this.userService.update(dbUser.id, { subscriptionExpiresAt: newExpiry });

    // Provision VPN
    const provisioned = await this.provisionVpnForUser(dbUser.id);

    const expiryStr = this.formatMskDate(newExpiry);
    const vpnButton = Markup.inlineKeyboard([
      [Markup.button.callback('🔐 Конфигурации VPN', 'vpn_config')],
      [Markup.button.callback('🔙 В меню', 'show_menu')],
    ]);

    if (provisioned) {
      await ctx.reply(
        `🎉 Спасибо за оплату!\n\n` +
        `✅ Подписка активирована до **${expiryStr}**\n` +
        `🔐 VPN-аккаунт создан:`,
        { parse_mode: 'Markdown', ...vpnButton },
      );
    } else {
      await ctx.reply(
        `🎉 Спасибо за оплату!\n\n` +
        `✅ Подписка активирована до **${expiryStr}**\n` +
        `⚠️ Не удалось создать VPN-аккаунт. Администратор решит проблему.`,
        { parse_mode: 'Markdown' },
      );
    }
  }
}
