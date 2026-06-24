import { Injectable, Logger } from '@nestjs/common';
import {Context, Markup} from "telegraf";
import { UserService } from '../../db/user.service';
import { User } from '../../db/entities/user.entity';
import { DepositService } from '../../db/deposit.service';
import { Deposit } from '../../db/entities/deposit.entity';
import { VpnKeyService } from '../../db/vpn-key.service';
import { VpnKey } from '../../db/entities/vpn-key.entity';
import { TicketService } from '../../db/ticket.service';
import { Ticket } from '../../db/entities/ticket.entity';
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
    private readonly vpnKeyService: VpnKeyService,
    private readonly ticketService: TicketService,
  ) {}

  /** Get support IDs from env */
  getSupportIds(): number[] {
    const raw = process.env.SUPPORT_IDS || process.env.ADMIN_IDS || '';
    return raw.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id));
  }

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
    const hasSub = dbUser ? await this.hasActiveSubscription(dbUser) : false;

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
      // // Markup.button.callback('Тест визарда', 'wizard_test'),
      // // Markup.button.callback('Тест сцены', 'scene_test'),
    ]);

    if (isAdmin) {
      buttons.push([Markup.button.callback('👥 Пользователи', 'seeusers')]);
      buttons.push([Markup.button.callback('⏳ Ожидают активации', 'pending_users')]);
      buttons.push([Markup.button.callback('💳 Ожидают пополнения', 'pending_deposits')]);
      buttons.push([Markup.button.callback('📝 Редактировать пользователей', 'edit_users')]);
      buttons.push([Markup.button.callback('🛟 Тикеты', 'admin_tickets')]);
      buttons.push([Markup.button.callback('⚙️ Настройки', 'admin_settings')]);
    }

    buttons.push([Markup.button.callback('Show menu', 'show_menu')]);

    await ctx.reply('Main menu:', Markup.inlineKeyboard(buttons));
  }

  async botMenu(ctx: Context) {
    await ctx.reply(
      'Используйте кнопки меню для навигации:',
      Markup.keyboard([
        ['🔌 Подключить VPN'],
        ['👤 Профиль', '🎁 Реферальная программа'],
        ['ℹ️ Информация'],
      ]).resize().persistent(),
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

  /** Show user's balance (USDT only — all deposits auto-converted) */
  async showUserBalance(ctx: Context, user: User) {
    const usdt = (user.userBalanceUSDT ?? 0).toFixed(2);

    const message =
      `💰 **Ваш баланс**\n\n` +
      `💵 **${usdt}** USDT`;

    const buttons: any[][] = [];
    if ((user.userBalanceUSDT ?? 0) > 0) {
      buttons.push([Markup.button.callback('🔌 Оформить подписку', 'buy')]);
    }
    buttons.push([Markup.button.callback('💳 Пополнить баланс', 'top_up')]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Check if user has at least one active key */
  async hasActiveSubscription(user: User): Promise<boolean> {
    const keys = await this.vpnKeyService.findByUserId(user.id);
    const now = new Date();
    return keys.some((k) => k.subscriptionExpiresAt && new Date(k.subscriptionExpiresAt) > now);
  }

  /** Show user's current subscription status (list of keys) */
  async showMySubscription(ctx: Context, user: User) {
    const keys = await this.vpnKeyService.findByUserId(user.id);
    const now = new Date();

    // Clean up expired peers
    for (const key of keys) {
      if (key.subscriptionExpiresAt && new Date(key.subscriptionExpiresAt) <= now) {
        await this.cleanupKey(key);
      }
    }

    // Refresh keys after cleanup
    const activeKeys = (await this.vpnKeyService.findByUserId(user.id))
      .filter((k) => k.subscriptionExpiresAt && new Date(k.subscriptionExpiresAt) > now);

    let message: string;
    if (activeKeys.length > 0) {
      let keysText = '';
      for (const k of activeKeys) {
        const daysLeft = Math.ceil((new Date(k.subscriptionExpiresAt!).getTime() - now.getTime()) / 86400_000);
        keysText += `🔑 Key${k.keyIndex}: ✅ до **${this.formatMskDate(k.subscriptionExpiresAt!)}** (${daysLeft} дн.)\n`;
      }
      message = `📋 **Мои подписки**\n\n${keysText}`;
    } else {
      message = `📋 **Мои подписки**\n\n❌ Нет активных ключей`;
    }

    const buttons: any[][] = [];

    if (activeKeys.length > 0) {
      buttons.push([Markup.button.callback('🔐 Конфигурации VPN', 'vpn_config')]);
    }
    buttons.push([Markup.button.callback('🔌 Оформить подписку', 'buy')]);
    buttons.push([Markup.button.callback('💳 Пополнить баланс', 'top_up')]);
    buttons.push([
      Markup.button.callback('🎁 Подарить подписку', 'gift_sub'),
      Markup.button.callback('👥 Пригласить друга', 'invite_friend'),
    ]);
    buttons.push([Markup.button.callback('🛟 Техподдержка', 'create_ticket')]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Fetch live BTC/USDT and/or GRAM/USDT rates from configured exchange (only enabled currencies) */
  async fetchCoinExRates(): Promise<{ btcUsdt: number; tonUsdt: number; exchange: string }> {
    const exchange = (process.env.EXCHANGE_API || 'coinex').toLowerCase();
    const enableBtc = process.env.ENABLE_BTC_PAYMENT !== 'false';
    const enableGram = process.env.ENABLE_GRAM_PAYMENT !== 'false';

    try {
      if (exchange === 'binance') {
        const fetches: Promise<any>[] = [];
        if (enableBtc) fetches.push(fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(r => r.json()));
        if (enableGram) fetches.push(fetch('https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT').then(r => r.json()));

        const results = await Promise.all(fetches);
        let btcUsdt = 0, tonUsdt = 0, idx = 0;
        if (enableBtc) btcUsdt = parseFloat(results[idx++]?.price) || 0;
        if (enableGram) tonUsdt = parseFloat(results[idx++]?.price) || 0;

        return { btcUsdt, tonUsdt, exchange: 'Binance' };
      }

      // Default: CoinEx v1
      const fetches: Promise<any>[] = [];
      if (enableBtc) fetches.push(fetch('https://api.coinex.com/v1/market/ticker?market=BTCUSDT').then(r => r.json()));
      if (enableGram) fetches.push(fetch('https://api.coinex.com/v1/market/ticker?market=GRAMUSDT').then(r => r.json()));

      const results = await Promise.all(fetches);
      let btcUsdt = 0, tonUsdt = 0, idx = 0;
      if (enableBtc) btcUsdt = parseFloat(results[idx++]?.data?.ticker?.last) || 0;
      if (enableGram) tonUsdt = parseFloat(results[idx++]?.data?.ticker?.last) || 0;

      return { btcUsdt, tonUsdt, exchange: 'CoinEx' };
    } catch {
      return { btcUsdt: 0, tonUsdt: 0, exchange: exchange };
    }
  }

  /** Calculate subscription plan prices from env */
  getSubscriptionPlans(rates: { btcUsdt: number; tonUsdt: number }) {
    const trialHours = parseInt(process.env.TRIAL_TIME || '24', 10) || 24;
    const plans = [
      { label: '🆓 Пробный', hours: trialHours, usdt: parseFloat(process.env.SUBSCRIPTION_24H_USDT || '0') },
      { label: '📅 7 дней', hours: 168, usdt: parseFloat(process.env.SUBSCRIPTION_7D_USDT || '5') },
      { label: '📅 14 дней', hours: 336, usdt: parseFloat(process.env.SUBSCRIPTION_14D_USDT || '13.5') },
      { label: '📅 1 месяц', hours: 720, usdt: parseFloat(process.env.SUBSCRIPTION_30D_USDT || '22.5') },
      { label: '📅 6 месяцев', hours: 4320, usdt: parseFloat(process.env.SUBSCRIPTION_180D_USDT || '90') },
    ];

    const enableBtc = process.env.ENABLE_BTC_PAYMENT !== 'false';
    const enableGram = process.env.ENABLE_GRAM_PAYMENT !== 'false';

    return plans.map((p) => {
      const btc = (enableBtc && rates.btcUsdt > 0) ? +(p.usdt / rates.btcUsdt).toFixed(8) : null;
      const gram = (enableGram && rates.tonUsdt > 0) ? +(p.usdt / rates.tonUsdt).toFixed(2) : null;
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

    // Build plans table with only enabled currencies
    let plansText = '';
    for (const p of plans) {
      const btcStr = p.btc !== null ? `~${p.btc} BTC` : '';
      const gramStr = p.gram !== null ? `~${p.gram} GRAM` : '';
      const altStr = [btcStr, gramStr].filter(Boolean).join(' / ');
      const altPart = altStr ? ` (${altStr})` : '';
      if (p.usdt === 0) {
        plansText += `${p.label}: **Бесплатно**\n`;
      } else {
        plansText += `${p.label}: **${p.usdt}** USDT${altPart}\n`;
      }
    }

    // Trial availability info
    let trialInfo = '';
    if (dbUser?.lastTrialAt) {
      const nextTrialAt = new Date(dbUser.lastTrialAt.getTime() + 60 * 24 * 3600_000);
      if (nextTrialAt > new Date()) {
        trialInfo = `⏳ Пробный период будет снова доступен с **${this.formatMskDate(nextTrialAt)}**\n`;
      } else {
        trialInfo = `✅ Пробный период доступен!\n`;
      }
    } else {
      trialInfo = `✅ Пробный период доступен!\n`;
    }

    const message =
      `🔌 **Оформление подписки**\n\n` +
      `💰 Ваш баланс: **${balance.toFixed(2)}** USDT\n\n` +
      `Тарифы:\n${plansText}\n` +
      trialInfo +
      `\nℹ️ Пробный период — раз в 2 месяца.\n\n` +
      `Выберите тариф:`;

    // Build plan buttons
    const planButtons: any[][] = plans.map((p) => {
      const label = p.usdt === 0
        ? `${p.label} — Бесплатно`
        : `${p.label} — ${p.usdt} USDT`;
      return [Markup.button.callback(label, `buyplan_${p.hours}`)];
    });

    planButtons.push([Markup.button.callback('💳 Пополнить баланс', 'top_up')]);
    planButtons.push([Markup.button.callback('🔙 Назад', 'my_subscription')]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(planButtons),
    });
  }

  /** Show top-up page with payment addresses (filtered by env) */
  async showTopUpBalance(ctx: Context) {
    const usdtAddr = process.env.USDT_PAYMENT_ADDRESS || 'не задан';
    const btcAddr = process.env.BTC_PAYMENT_ADDRESS || 'не задан';
    const gramAddr = process.env.GRAM_PAYMENT_ADDRESS || 'не задан';
    const enableBtc = process.env.ENABLE_BTC_PAYMENT !== 'false';
    const enableGram = process.env.ENABLE_GRAM_PAYMENT !== 'false';

    let addrText = `💵 USDT: \`${usdtAddr}\`\n`;
    if (enableBtc) addrText += `₿  BTC: \`${btcAddr}\`\n`;
    if (enableGram) addrText += `💎 GRAM: \`${gramAddr}\`\n`;

    const message =
      `💳 **Пополнение баланса**\n\n` +
      `Отправьте криптовалюту на один из адресов:\n\n` +
      addrText +
      `\nПосле отправки нажмите «💳 Завершение пополнения» и укажите TxID.`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Завершение пополнения', 'i_paid')],
      ]),
    });
  }

  /** Get enabled currencies based on env settings */
  getEnabledCurrencies(): string[] {
    const list = ['USDT'];
    if (process.env.ENABLE_BTC_PAYMENT !== 'false') list.push('BTC');
    if (process.env.ENABLE_GRAM_PAYMENT !== 'false') list.push('GRAM');
    return list;
  }

  /** Clean up a single expired key */
  async cleanupKey(key: VpnKey): Promise<void> {
    this.logger.log(`Cleaning up expired key ${key.keyIndex} (peer=${key.peerId})`);
    await this.amneziaService.deleteClient(key.peerId);
    await this.vpnKeyService.delete(key.id);
  }

  // ─── Key provisioning ─────────────────────────────────────

  /** Create a new key for user: AmneziaWG client + VpnKey record */
  async provisionKey(user: User, expireHours: number): Promise<{ key: VpnKey; config: string } | null> {
    const index = await this.vpnKeyService.getNextIndex(user.id);
    const clientName = `${user.firstName || user.username || `user_${user.telegramId}`} Key${index}`;

    const client = await this.amneziaService.createClient(clientName, expireHours);
    if (!client) {
      this.logger.error(`Failed to create AmneziaWG client for ${user.telegramId} Key${index}`);
      return null;
    }

    const expiry = new Date(Date.now() + expireHours * 3600_000);
    const key = await this.vpnKeyService.create({
      userId: user.id,
      keyIndex: index,
      peerId: client.id,
      subscriptionExpiresAt: expiry,
    });

    const config = await this.amneziaService.getClientConfig(client.id);
    if (!config) {
      this.logger.error(`Failed to get config for Key${index}`);
      return null;
    }

    return { key, config };
  }

  /** Get config for an existing key */
  async getKeyConfig(key: VpnKey): Promise<string | null> {
    return this.amneziaService.getClientConfig(key.peerId);
  }

  /** Get a VpnKey by id */
  async getVpnKey(keyId: number): Promise<VpnKey | null> {
    return this.vpnKeyService.findById(keyId);
  }

  /** Delete a key: AmneziaWG client + DB record */
  async deleteKey(key: VpnKey): Promise<void> {
    await this.amneziaService.deleteClient(key.peerId);
    await this.vpnKeyService.delete(key.id);
    this.logger.log(`Deleted Key${key.keyIndex} (peer=${key.peerId})`);
  }

  /** Get all keys for a user */
  async getUserKeys(userId: number): Promise<VpnKey[]> {
    return this.vpnKeyService.findByUserId(userId);
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

    // ── Free trial (24h): check 2-month cooldown ──
    const TRIAL_COOLDOWN_MS = 60 * 24 * 3600_000; // 60 days
    if (plan.usdt === 0 && dbUser.lastTrialAt) {
      const nextTrialAt = new Date(dbUser.lastTrialAt.getTime() + TRIAL_COOLDOWN_MS);
      if (nextTrialAt > new Date()) {
        const availableAt = this.formatMskDate(nextTrialAt);
        await ctx.reply(
          `❌ Пробный период уже был активирован.\n\n` +
          `📅 Последний триал: **${this.formatMskDate(dbUser.lastTrialAt)}**\n` +
          `⏳ Следующий доступен с: **${availableAt}**\n\n` +
          `💡 Вы можете оплатить любой тариф с баланса прямо сейчас.`,
          { parse_mode: 'Markdown' },
        );
        return false;
      }
    }

    // Check balance (skip for free plans)
    if (plan.usdt > 0 && (dbUser.userBalanceUSDT ?? 0) < plan.usdt) {
      await ctx.reply(
        `❌ Недостаточно средств!\n\n` +
        `Тариф: **${plan.usdt}** USDT\n` +
        `Ваш баланс: **${(dbUser.userBalanceUSDT ?? 0).toFixed(2)}** USDT\n\n` +
        `Пополните баланс через «💳 Пополнить баланс».`,
        { parse_mode: 'Markdown' },
      );
      return false;
    }

    // Deduct from balance
    if (plan.usdt > 0) {
      const newBalance = (dbUser.userBalanceUSDT ?? 0) - plan.usdt;
      await this.userService.update(dbUser.id, { userBalanceUSDT: newBalance });
    }

    // Record trial usage
    if (plan.usdt === 0) {
      const now = new Date();
      await this.userService.update(dbUser.id, { lastTrialAt: now });
    }

    // Provision new key
    const result = await this.provisionKey(dbUser, planHours);
    if (!result) {
      await ctx.reply(
        `⚠️ Не удалось создать VPN-ключ. Администратор решит проблему.`,
        { parse_mode: 'Markdown' },
      );
      // Refund if paid
      if (plan.usdt > 0) {
        const refund = (dbUser.userBalanceUSDT ?? 0);
        await this.userService.update(dbUser.id, { userBalanceUSDT: refund + plan.usdt });
      }
      return false;
    }

    const { key } = result;
    const expiryStr = this.formatMskDate(key.subscriptionExpiresAt!);
    const vpnButton = Markup.inlineKeyboard([
      [Markup.button.callback('🔐 Конфигурации VPN', 'vpn_config')],
      [Markup.button.callback('🔙 В меню', 'show_menu')],
    ]);

    if (plan.usdt === 0) {
      await ctx.reply(
        `🎉 **${plan.label}** активирован!\n\n` +
        `🔑 **Key${key.keyIndex}** создан\n` +
        `📅 До: **${expiryStr}**\n` +
        `\n🔐 Готов к использованию:`,
        { parse_mode: 'Markdown', ...vpnButton },
      );
    } else {
      await ctx.reply(
        `✅ Подписка оплачена с баланса!\n\n` +
        `🔑 **Key${key.keyIndex}** создан\n` +
        `💸 Списано: **${plan.usdt}** USDT\n` +
        `💰 Остаток: **${((dbUser.userBalanceUSDT ?? 0) - plan.usdt).toFixed(2)}** USDT\n` +
        `📅 До: **${expiryStr}**\n` +
        `\n🔐 Готов к использованию:`,
        { parse_mode: 'Markdown', ...vpnButton },
      );
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

    const keyCount = (await this.vpnKeyService.findByUserId(user.id)).length;
    const peerInfo = keyCount > 0
      ? `\n🔐 Ключей: **${keyCount}**`
      : '\n🔐 Ключей: нет';

    const info =
      `📝 **Редактирование пользователя**\n\n` +
      `${roleIcon} **${name}** (${username})\n` +
      `🆔 Telegram ID: \`${user.telegramId}\`\n` +
      `💼 Роль: ${user.role}\n` +
      `💰 Баланс: ${user.userBalanceUSDT} USDT / ${user.userBalanceBTC} BTC / ${user.userBalanceGram} GRAM\n` +
      `📌 Статус: ${activeStatus}\n` +
      `🔑 Ключей: **${keyCount}**\n` +
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

  /** Convert any currency amount to USDT using current rates */
  async convertToUsdt(amount: number, currency: string): Promise<number> {
    if (currency === 'USDT') return amount;
    const rates = await this.fetchCoinExRates();
    if (currency === 'BTC' && rates.btcUsdt > 0) return amount * rates.btcUsdt;
    if (currency === 'GRAM' && rates.tonUsdt > 0) return amount * rates.tonUsdt;
    return 0; // fallback: rate unavailable
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

  /** Show subscription management page (admin) — shows all keys */
  async showSubscriptionManagement(ctx: Context, user: User) {
    const keys = await this.vpnKeyService.findByUserId(user.id);
    const now = new Date();

    let keysText = '';
    for (const k of keys) {
      const active = k.subscriptionExpiresAt && new Date(k.subscriptionExpiresAt) > now;
      const status = active ? '✅' : '❌';
      const expiry = k.subscriptionExpiresAt ? this.formatMskDate(k.subscriptionExpiresAt) : 'нет';
      keysText += `🔑 Key${k.keyIndex}: ${status} до ${expiry} (пир: \`${k.peerId.slice(0, 8)}...\`)\n`;
    }

    if (keys.length === 0) {
      keysText = '🔐 Нет ключей';
    }

    const message =
      `⚙️ **Управление подпиской**\n\n` +
      `${keysText}\n` +
      `Выберите действие:`;

    const buttons: any[][] = [
      [Markup.button.callback('✏️ Изменить время подписки', `ef_subscriptionExpiresAt_${user.id}`)],
      [Markup.button.callback('🔙 Назад', `edit_user_${user.telegramId}`)],
    ];

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Toggle AmneziaWG client enabled/disabled by key ID */
  async toggleClient(keyId: number, enable: boolean): Promise<boolean> {
    const key = await this.vpnKeyService.findById(keyId);
    if (!key) return false;

    return enable
      ? this.amneziaService.enableClient(key.peerId)
      : this.amneziaService.disableClient(key.peerId);
  }

  /** Show "Профиль" page */
  async showProfile(ctx: Context) {
    await ctx.reply('🔐 **Профиль**\n\nВыберите раздел:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔐 Конфигурации VPN', 'vpn_keys')],
        [Markup.button.callback('🔙 Назад', 'my_subscription')],
      ]),
    });
  }

  /** Show list of keys for config download */
  async showVpnKeys(ctx: Context) {
    const tgUser = ctx.from!;
    const dbUser = await this.userService.findByTelegramId(tgUser.id);
    if (!dbUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    const keys = await this.vpnKeyService.findByUserId(dbUser.id);
    const now = new Date();
    const activeKeys = keys.filter((k) => k.subscriptionExpiresAt && new Date(k.subscriptionExpiresAt) > now);

    if (activeKeys.length === 0) {
      await ctx.reply('❌ Нет активных ключей.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'my_subscription')]]),
      });
      return;
    }

    const buttons: any[][] = activeKeys.map((k) => {
      const daysLeft = Math.ceil((new Date(k.subscriptionExpiresAt!).getTime() - now.getTime()) / 86400_000);
      return [Markup.button.callback(
        `🔑 Key${k.keyIndex} — до ${this.formatMskDate(k.subscriptionExpiresAt!)} (${daysLeft} дн.)`,
        `keycfg_${k.id}`,
      )];
    });

    buttons.push([Markup.button.callback('🔙 Назад', 'my_subscription')]);

    await ctx.reply('🔐 **Конфигурации VPN**\n\nВыберите ключ:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /** Show actions for a specific key */
  async showKeyActions(ctx: Context, keyId: number) {
    const key = await this.vpnKeyService.findById(keyId);
    if (!key) {
      await ctx.reply('❌ Ключ не найден.');
      return;
    }

    const message =
      `🔑 **Key${key.keyIndex}**\n` +
      `📅 До: **${this.formatMskDate(key.subscriptionExpiresAt!)}**\n\n` +
      `Выберите действие:`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Скачать конфигурацию', `getlink_${key.id}`)],
        [Markup.button.callback('📱 Получить QRcode', `getqr_${key.id}`)],
        [Markup.button.callback('🔗 Одноразовая ссылка', `otlink_${key.id}`)],
        [Markup.button.callback('🗑 Удалить ключ', `delkey_${key.id}`)],
        [Markup.button.callback('🔙 Назад', 'vpn_keys')],
      ]),
    });
  }

  // ─── Deposit / Payment verification ─────────────────────

  /** Ask user to select currency for deposit (filtered by env) */
  async showDepositCurrencySelect(ctx: Context) {
    const currencies = this.getEnabledCurrencies();
    const currencyButtons: any[] = [];
    const labels: Record<string, string> = { USDT: '💵 USDT', BTC: '₿ BTC', GRAM: '💎 GRAM' };

    // Build row(s) of currency buttons
    for (let i = 0; i < currencies.length; i += 3) {
      currencyButtons.push(
        currencies.slice(i, i + 3).map((c) =>
          Markup.button.callback(labels[c] || c, `dep_currency_${c}`),
        ),
      );
    }

    await ctx.reply(
      '💳 **Завершение пополнения**\n\nВыберите валюту пополнения:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          ...currencyButtons,
          [Markup.button.callback('❌ Отменить', 'cancel_action')],
        ]),
      },
    );
  }

  /** Prompt user to enter TxID (amount will be fetched from blockchain later) */
  async showTxIdPrompt(ctx: Context, currency: string) {
    await ctx.reply(
      `📝 Введите **TxID** транзакции:\n\n` +
      `Пример: \`abc123def456...\`\n\n` +
      `Валюта: **${currency}**\n` +
      `Нажмите ❌ Отменить для отмены`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отменить', 'cancel_action')],
        ]),
      },
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

      if (expectedAmount > 0 && Math.abs(totalToUs - expectedAmount) > 0.0001) {
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

  /** Generate one-time config link for a key */
  async getOneTimeLink(keyId: number): Promise<string | null> {
    const key = await this.vpnKeyService.findById(keyId);
    if (!key) return null;
    return this.amneziaService.getOneTimeLink(key.peerId);
  }

  /** Update key subscription expiry — DB + AmneziaWG sync */
  async updateKeySubscription(
    keyId: number,
    newExpiry: Date,
  ): Promise<{ synced: boolean }> {
    const key = await this.vpnKeyService.findById(keyId);
    if (!key) return { synced: false };

    await this.vpnKeyService.update(keyId, { subscriptionExpiresAt: newExpiry });

    const synced = await this.amneziaService.updateClientExpireDate(
      key.peerId,
      newExpiry.toISOString(),
    );
    return { synced };
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
