export function chatMessagesFromBuiltPrompt(prompt) {
  const [system, rules, user, trailingContext] = prompt.blocks;
  if (
    typeof system !== 'string' ||
    typeof rules !== 'string' ||
    typeof user !== 'string'
  )
    throw new TypeError('built prompt is missing a required message block');

  return [
    { role: 'system', content: `${system}\n\n${rules}` },
    {
      role: 'user',
      content: user + (trailingContext ? `\n\n${trailingContext}` : ''),
    },
  ];
}

export function generateWithBuiltPrompt(prompt, chat, options = {}) {
  return chat(chatMessagesFromBuiltPrompt(prompt), options);
}
