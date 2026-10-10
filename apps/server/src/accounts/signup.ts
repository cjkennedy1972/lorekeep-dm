import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { attestAdult } from './retryBlock.js';
import { hashPassword, validPassword } from './password.js';
import { sendBestEffort, type EmailSender } from '../email/sender.js';

export const signupSchema = z
  .object({
    email: z.email(),
    password: z.string(),
    displayName: z.string().trim().min(1).max(80),
    birthdate: z.iso.date(),
    termsVersion: z.string().min(1).max(40),
  })
  .strict();
export type SignupInput = z.infer<typeof signupSchema>;
export const signupResponse = {
  message: 'If eligible, check your email for a verification link.',
};
export const underageResponse = {
  code: 'UNDERAGE',
  message: 'You must be 18 or older to create an account.',
};
export type NameFilter = (name: string) => boolean;
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export async function signup(
  db: Pool,
  sender: EmailSender,
  input: SignupInput,
  options: {
    cookie?: string;
    cookieSecret: string;
    nameFilter?: NameFilter;
    now?: Date;
  },
): Promise<{
  response: typeof signupResponse | typeof underageResponse;
  retryBlockCookie?: string;
  refused?: boolean;
  sent?: Promise<string | undefined>;
}> {
  const now = options.now ?? new Date();
  const age = attestAdult(
    input.birthdate,
    options.cookie,
    options.cookieSecret,
    now,
  );
  if (!age.allowed)
    return {
      response: underageResponse,
      retryBlockCookie: age.retryBlockCookie,
      refused: true,
    };
  if (
    !validPassword(input.password) ||
    !(options.nameFilter ?? (() => true))(input.displayName)
  )
    throw new RangeError('Invalid signup details');
  const passwordHash = await hashPassword(input.password);
  const token = randomBytes(32).toString('base64url');
  const client = await db.connect();
  let inserted = false;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES ($1,$2,$3,$4,'pending_email',true,$5,$6,$7)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        input.email.trim().toLowerCase(),
        passwordHash,
        input.displayName,
        age.ageCheckedAt,
        input.termsVersion,
        now,
      ],
    );
    if (result.rowCount === 1) {
      inserted = true;
      await client.query(
        "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES ($1,$2,'verify',$3)",
        [
          hashToken(token),
          result.rows[0].id,
          new Date(now.getTime() + 24 * 3600_000),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!inserted) return { response: signupResponse };
  // The account and token are committed; a failed send is recoverable via resend. Not awaited so send latency cannot reveal existing accounts.
  const sent = sendBestEffort(() =>
    sender.sendVerification(input.email.trim().toLowerCase(), token),
  );
  return { response: signupResponse, sent };
}
