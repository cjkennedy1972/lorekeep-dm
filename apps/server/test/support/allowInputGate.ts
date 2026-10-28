import type { ChatInputResult, InputGate } from '../../src/safety/inputGate.js';

const allowResult: ChatInputResult = {
  decision: 'allow',
  source: 'judge',
  category: 'none',
  attributable: true,
};

export const allowInputGate: InputGate = {
  check: async () => 'allow',
  checkDetailed: async () => allowResult,
};
