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
