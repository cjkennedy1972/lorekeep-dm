import type { ServerConfig } from '../config.js';
import { ResendEmailSender } from './resend.js';

export interface EmailSender {
  sendVerification(email: string, token: string): Promise<void>;
  sendPasswordReset?(email: string, token: string): Promise<void>;
}
export class MemoryEmailSender implements EmailSender {
  readonly messages: { email: string; token: string }[] = [];
  async sendVerification(email: string, token: string): Promise<void> {
    this.messages.push({ email, token });
  }
  async sendPasswordReset(email: string, token: string): Promise<void> {
    this.messages.push({ email, token });
  }
}
/** Development only. Never prints the token: inspect the memory sender in tests. */
export class ConsoleEmailSender implements EmailSender {
  async sendPasswordReset(_email: string, _token: string): Promise<void> {
    void _email;
    void _token;
    console.info(
      'Password reset email requested (delivery provider not configured)',
    );
  }
  async sendVerification(_email: string, _token: string): Promise<void> {
    void _email;
    void _token;
    console.info(
      'Verification email requested (delivery provider not configured)',
    );
  }
}
type EmailConfig = Pick<
  ServerConfig,
  'NODE_ENV' | 'RESEND_API_KEY' | 'EMAIL_FROM' | 'APP_BASE_URL'
>;
export function emailSenderFromConfig(config: EmailConfig): EmailSender {
  const settings = {
    RESEND_API_KEY: config.RESEND_API_KEY?.reveal(),
    EMAIL_FROM: config.EMAIL_FROM,
    APP_BASE_URL: config.APP_BASE_URL,
  };
  const missing = Object.entries(settings)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length === 0)
    return new ResendEmailSender({
      apiKey: settings.RESEND_API_KEY!,
      from: settings.EMAIL_FROM!,
      appBaseUrl: settings.APP_BASE_URL!,
    });
  if (missing.length < Object.keys(settings).length)
    throw new Error(
      `Incomplete email configuration: missing ${missing.join(', ')}`,
    );
  if (config.NODE_ENV === 'development' || config.NODE_ENV === 'test')
    return new ConsoleEmailSender();
  throw new Error(
    'Email delivery is not configured: set RESEND_API_KEY, EMAIL_FROM and APP_BASE_URL',
  );
}
