import { z } from 'zod';

const id = () => z.uuid();
export const AccountIdSchema = id().brand<'AccountId'>();
export const SessionIdSchema = id().brand<'SessionId'>();
export const TurnIdSchema = id().brand<'TurnId'>();
export const ActionIdSchema = id().brand<'ActionId'>();
export const SeatIdSchema = id().brand<'SeatId'>();
export type AccountId = z.infer<typeof AccountIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type TurnId = z.infer<typeof TurnIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type SeatId = z.infer<typeof SeatIdSchema>;
