import { describe, expect, it } from 'vitest';
import { ChatMessageSchema, ChatSendSchema } from '../src/ws.js';

const send = {
  actionId: '9a5a582d-9b8b-4fd1-9d10-fc3de85e98e5',
  type: 'ChatSend',
  payload: { text: ' hello ' },
  lastSeq: 0,
};

describe('OOC chat wire contract', () => {
  it('accepts chat text only within the normalized 2,000-character limit', () => {
    expect(ChatSendSchema.parse(send).payload.text).toBe('hello');
    expect(
      ChatSendSchema.safeParse({ ...send, payload: { text: 'x'.repeat(2001) } })
        .success,
    ).toBe(false);
  });

  it('normalizes to NFC before applying the length limit', () => {
    const composed = ChatSendSchema.parse({
      ...send,
      payload: { text: `${'e\u0301'.repeat(2000)}` },
    });
    expect(Array.from(composed.payload.text)).toHaveLength(2000);
    expect(composed.payload.text).toBe('é'.repeat(2000));
  });

  it('rejects empty normalized text and records only allow decisions', () => {
    expect(
      ChatSendSchema.safeParse({ ...send, payload: { text: '  ' } }).success,
    ).toBe(false);
    expect(
      ChatMessageSchema.safeParse({
        messageId: '9a5a582d-9b8b-4fd1-9d10-fc3de85e98e5',
        roomId: '9a5a582d-9b8b-4fd1-9d10-fc3de85e98e5',
        seatId: '9a5a582d-9b8b-4fd1-9d10-fc3de85e98e5',
        receiptSeq: 1,
        receivedAt: 1,
        text: 'hello',
        channel: 'ooc',
        gateDecision: {
          verdict: 'allow',
          moderationLogId: '9a5a582d-9b8b-4fd1-9d10-fc3de85e98e5',
        },
      }).success,
    ).toBe(true);
  });
});
