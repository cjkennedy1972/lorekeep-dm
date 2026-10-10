import type { EmailSender } from './sender.js';

export interface ResendEmailSenderOptions {
  apiKey: string;
  from: string;
  /** Public web origin; links point at its /verify and /reset routes. */
  appBaseUrl: string;
  fetch?: typeof fetch;
}

const RESEND_URL = 'https://api.resend.com/emails';

/** Never logs: a failed send reports only the HTTP status. */
export class ResendEmailSender implements EmailSender {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendEmailSenderOptions) {
    this.base = options.appBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async sendVerification(email: string, token: string): Promise<void> {
    await this.send(
      email,
      'Verify your Lorekeep account',
      `Confirm your email to finish creating your Lorekeep account:\n\n${this.link('verify', token)}\n\nIf you did not sign up, you can ignore this message.`,
    );
  }

  async sendPasswordReset(email: string, token: string): Promise<void> {
    await this.send(
      email,
      'Reset your Lorekeep password',
      `Reset your Lorekeep password:\n\n${this.link('reset', token)}\n\nThe link expires in one hour. If you did not ask for a reset, you can ignore this message.`,
    );
  }

  private link(path: 'verify' | 'reset', token: string): string {
    return `${this.base}/${path}?token=${encodeURIComponent(token)}`;
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    const response = await this.fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [to],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Email delivery failed with status ${response.status}`);
  }
}
