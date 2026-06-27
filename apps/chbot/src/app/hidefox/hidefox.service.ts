import { Injectable, Logger } from '@nestjs/common';

interface HideFoxClient {
  id: string;
  name: string;
  enabled: boolean;
  address: string;
  publicKey: string;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
  downloadableConfig: boolean;
  latestHandshakeAt: string | null;
  transferRx: number;
  transferTx: number;
  oneTimeLink: string | null;
  oneTimeLinkExpiresAt: string | null;
}

@Injectable()
export class HideFoxService {
  private readonly logger = new Logger(HideFoxService.name);
  private sessionCookie: string | null = null;
  private lastAuthTime = 0;
  private serverUrl: string;
  private password: string;

  constructor() {
    this.serverUrl = (process.env.AMNEZIA_SERVER_URL || 'http://127.0.0.1:13544').replace(/\/$/, '');
    this.password = process.env.AMNEZIA_ADMIN_PASSWORD || '';
  }

  /** Authenticate with the HideFox VPN admin panel */
  async login(): Promise<boolean> {
    if (!this.password) {
      this.logger.error('AMNEZIA_ADMIN_PASSWORD is not set');
      return false;
    }

    try {
      const res = await fetch(`${this.serverUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.password, remember: true }),
      });

      if (!res.ok) {
        this.logger.error(`Login failed: ${res.status}`);
        return false;
      }

      const data = await res.json() as any;
      if (!data.success) {
        this.logger.error('Login failed: unexpected response');
        return false;
      }

      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        this.sessionCookie = setCookie.split(';')[0];
        this.lastAuthTime = Date.now();
        this.logger.log('Authenticated with HideFox VPN admin panel');
        return true;
      }

      this.logger.error('No session cookie in response');
      return false;
    } catch (err) {
      this.logger.error(`Login error: ${(err as Error).message}`);
      return false;
    }
  }

  /** Ensure we have a valid session, re-login if needed.
   *  Caches auth for 5 minutes to avoid redundant session checks. */
  private async ensureAuth(): Promise<boolean> {
    // If we authenticated recently, assume session is still valid
    if (this.sessionCookie && (Date.now() - this.lastAuthTime) < 300_000) {
      return true;
    }
    // Otherwise verify session or re-login
    if (this.sessionCookie) {
      try {
        const res = await fetch(`${this.serverUrl}/api/session`, {
          headers: { Cookie: this.sessionCookie },
        });
        const data = await res.json() as any;
        if (data.authenticated) {
          this.lastAuthTime = Date.now();
          return true;
        }
      } catch (_) {}
    }
    return this.login();
  }

  /** List all clients */
  async listClients(): Promise<HideFoxClient[]> {
    const authed = await this.ensureAuth();
    if (!authed) return [];

    try {
      const res = await fetch(`${this.serverUrl}/api/wireguard/client`, {
        headers: { Cookie: this.sessionCookie! },
      });
      if (!res.ok) return [];
      return (await res.json()) as HideFoxClient[];
    } catch (err) {
      this.logger.error(`List clients error: ${(err as Error).message}`);
      return [];
    }
  }

  /** Create a new VPN client (peer). Returns the created client or null. */
  async createClient(
    name: string,
    expireHours?: number,
  ): Promise<HideFoxClient | null> {
    const authed = await this.ensureAuth();
    if (!authed) {
      this.logger.error('Not authenticated with HideFox VPN');
      return null;
    }

    try {
      // Snapshot existing client IDs before creation
      const before = await this.listClients();
      const beforeIds = new Set(before.map((c) => c.id));

      const body: Record<string, any> = { name };
      if (expireHours && expireHours > 0) {
        body.expiredDate = new Date(Date.now() + expireHours * 3600 * 1000).toISOString();
      }

      const res = await fetch(`${this.serverUrl}/api/wireguard/client`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.sessionCookie!,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(`Create client failed (${res.status}): ${errText}`);
        return null;
      }

      const data = await res.json() as any;
      if (!data.success) {
        this.logger.error(`Create client returned unexpected: ${JSON.stringify(data)}`);
        return null;
      }

      // Find the newly created client by listing and diffing
      const after = await this.listClients();
      const newClient = after.find((c) => !beforeIds.has(c.id));
      const client = newClient || after.find((c) => c.name === name && !beforeIds.has(c.id));

      if (!client) {
        this.logger.warn(`Created client "${name}" but could not find it in list`);
        return null;
      }

      // Set ACL groups: telegram + user
      await this.setClientAclGroups(client.id, ['telegram', 'user']);

      this.logger.log(`Created client "${name}" (id=${client.id})`);
      return client;
    } catch (err) {
      this.logger.error(`Create client error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Get client configuration file content */
  async getClientConfig(clientId: string): Promise<string | null> {
    const authed = await this.ensureAuth();
    if (!authed) {
      this.logger.error('Not authenticated with HideFox VPN');
      return null;
    }

    try {
      const res = await fetch(
        `${this.serverUrl}/api/wireguard/client/${encodeURIComponent(clientId)}/configuration`,
        { headers: { Cookie: this.sessionCookie! } },
      );

      if (!res.ok) {
        this.logger.error(`Get client config failed (${res.status})`);
        return null;
      }

      return await res.text();
    } catch (err) {
      this.logger.error(`Get client config error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Delete a client from the server */
  async deleteClient(clientId: string): Promise<boolean> {
    const authed = await this.ensureAuth();
    if (!authed) return false;

    try {
      const res = await fetch(
        `${this.serverUrl}/api/wireguard/client/${encodeURIComponent(clientId)}`,
        {
          method: 'DELETE',
          headers: { Cookie: this.sessionCookie! },
        },
      );

      if (!res.ok) {
        this.logger.error(`Delete client failed (${res.status})`);
        return false;
      }

      this.logger.log(`Deleted client ${clientId}`);
      return true;
    } catch (err) {
      this.logger.error(`Delete client error: ${(err as Error).message}`);
      return false;
    }
  }

  /** Set ACL groups for a client */
  private async setClientAclGroups(clientId: string, aclGroups: string[]): Promise<void> {
    try {
      const res = await fetch(
        `${this.serverUrl}/api/wireguard/client/${encodeURIComponent(clientId)}/acl-groups/`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: this.sessionCookie!,
          },
          body: JSON.stringify({ aclGroups }),
        },
      );
      if (!res.ok) {
        this.logger.warn(`Failed to set ACL groups for ${clientId}: ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`ACL groups error: ${(err as Error).message}`);
    }
  }

  /** Enable a client */
  async enableClient(clientId: string): Promise<boolean> {
    return this.toggleClient(clientId, 'enable');
  }

  /** Disable a client */
  async disableClient(clientId: string): Promise<boolean> {
    return this.toggleClient(clientId, 'disable');
  }

  private async toggleClient(clientId: string, action: 'enable' | 'disable'): Promise<boolean> {
    const authed = await this.ensureAuth();
    if (!authed) return false;

    try {
      const res = await fetch(
        `${this.serverUrl}/api/wireguard/client/${encodeURIComponent(clientId)}/${action}`,
        { method: 'POST', headers: { Cookie: this.sessionCookie! } },
      );

      if (!res.ok) {
        this.logger.error(`Client ${action} failed (${res.status})`);
        return false;
      }

      this.logger.log(`Client ${clientId} ${action}d`);
      return true;
    } catch (err) {
      this.logger.error(`Client ${action} error: ${(err as Error).message}`);
      return false;
    }
  }

  /** Update client's expiration date */
  async updateClientExpireDate(clientId: string, expireDate: string): Promise<boolean> {
    const authed = await this.ensureAuth();
    if (!authed) return false;

    try {
      const res = await fetch(
        `${this.serverUrl}/api/wireguard/client/${encodeURIComponent(clientId)}/expireDate/`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: this.sessionCookie!,
          },
          body: JSON.stringify({ expireDate }),
        },
      );

      if (!res.ok) {
        this.logger.error(`Update expire date failed (${res.status})`);
        return false;
      }

      this.logger.log(`Updated expire date for client ${clientId} → ${expireDate}`);
      return true;
    } catch (err) {
      this.logger.error(`Update expire date error: ${(err as Error).message}`);
      return false;
    }
  }

  /** Generate a one-time config link, returns full URL */
  async getOneTimeLink(clientId: string): Promise<string | null> {
    const authed = await this.ensureAuth();
    if (!authed) return null;

    try {
      const res = await fetch(
        `${this.serverUrl}/api/wireguard/client/${encodeURIComponent(clientId)}/generateOneTimeLink`,
        {
          method: 'POST',
          headers: { Cookie: this.sessionCookie! },
        },
      );

      if (!res.ok) return null;

      const data = await res.json() as any;
      if (!data.success) return null;

      // Re-fetch client to get the generated token
      const clients = await this.listClients();
      const client = clients.find((c) => c.id === clientId);
      if (!client?.oneTimeLink) return null;

      // Construct full URL: <server>/cnf/<token>
      return `${this.serverUrl}/cnf/${client.oneTimeLink}`;
    } catch (_) {
      return null;
    }
  }
}
