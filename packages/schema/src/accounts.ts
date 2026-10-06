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
