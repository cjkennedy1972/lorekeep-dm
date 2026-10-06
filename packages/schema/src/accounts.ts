import { z } from 'zod';
import { AccountIdSchema } from './ids.js';

export const SignupInputSchema = z.object({
  email: z.email(),
  password: z.string().min(12),
  displayName: z.string().min(1).max(80),
  birthdate: z.iso.date(),
});
export const LoginInputSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export const AccountSchema = z.object({
  id: AccountIdSchema,
  email: z.email(),
  displayName: z.string().min(1),
  isAdult: z.boolean(),
  ageCheckedAt: z.iso.datetime(),
});
export const SignupOutputSchema = z.object({ account: AccountSchema });
export const LoginOutputSchema = z.object({ account: AccountSchema });
export const MeOutputSchema = z.object({ account: AccountSchema });
export type SignupInput = z.infer<typeof SignupInputSchema>;
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type SignupOutput = z.infer<typeof SignupOutputSchema>;
export type LoginOutput = z.infer<typeof LoginOutputSchema>;
export type MeOutput = z.infer<typeof MeOutputSchema>;

export const DeviceSessionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  lastActiveAt: z.iso.datetime(),
  current: z.boolean(),
});
export const SessionsOutputSchema = z.object({
  sessions: z.array(DeviceSessionSchema),
});
export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});
export const DeleteAccountInputSchema = z.object({
  password: z.string().min(1),
  confirmation: z.literal('DELETE MY ACCOUNT'),
});
export const ExportJobSchema = z.object({
  status: z.enum(['pending', 'ready', 'expired']),
  requestedAt: z.iso.datetime(),
  /** Present when ready. */
  downloadUrl: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
});
export const ExportJobOutputSchema = z.object({
  job: ExportJobSchema.nullable(),
});
export type DeviceSession = z.infer<typeof DeviceSessionSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
export type DeleteAccountInput = z.infer<typeof DeleteAccountInputSchema>;
export type ExportJob = z.infer<typeof ExportJobSchema>;
