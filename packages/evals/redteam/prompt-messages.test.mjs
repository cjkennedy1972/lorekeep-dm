import { describe, expect, it, vi } from 'vitest';
import {
  chatMessagesFromBuiltPrompt,
  generateWithBuiltPrompt,
} from './prompt-messages.mjs';

describe('chatMessagesFromBuiltPrompt', () => {
  it('converts built prompt blocks into the chat API message array', () => {
    const prompt = {
      messages: 'legacy formatted prompt string',
      blocks: ['DM role', 'Safety rules', 'Player turn', 'Scene summary'],
    };

    const messages = chatMessagesFromBuiltPrompt(prompt);

    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toEqual([
      { role: 'system', content: 'DM role\n\nSafety rules' },
      { role: 'user', content: 'Player turn\n\nScene summary' },
    ]);
  });

  it('accepts a built prompt without an optional trailing context block', () => {
    const messages = chatMessagesFromBuiltPrompt({
      messages: 'legacy formatted prompt string',
      blocks: ['DM role', 'Safety rules', 'Player turn'],
    });

    expect(messages[1]).toEqual({ role: 'user', content: 'Player turn' });
  });

  it('rejects a prompt missing a required block', () => {
    expect(() =>
      chatMessagesFromBuiltPrompt({ blocks: ['DM role', 'Safety rules'] }),
    ).toThrow('built prompt is missing a required message block');
  });

  it('sends the block-converted array rather than the legacy formatted string', async () => {
    const prompt = {
      messages: 'legacy formatted prompt string',
      blocks: ['DM role', 'Safety rules', 'Player turn'],
    };
    const chat = vi.fn().mockResolvedValue({ content: 'narration' });

    const result = await generateWithBuiltPrompt(prompt, chat, {
      tool_choice: 'auto',
    });

    expect(chat).toHaveBeenCalledWith(
      [
        { role: 'system', content: 'DM role\n\nSafety rules' },
        { role: 'user', content: 'Player turn' },
      ],
      { tool_choice: 'auto' },
    );
    expect(result).toEqual({ content: 'narration' });
  });
});
