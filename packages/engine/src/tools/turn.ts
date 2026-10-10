export type TurnResources = {
  action: boolean;
  bonusAction: boolean;
  reaction: boolean;
  movementRemaining: number;
};
export type TurnState = {
  activeEntityId: string | null;
  resources: Readonly<Record<string, TurnResources>>;
};

export function actionBlock(
  combat: TurnState | undefined,
  actorId: string,
): { code: 'not-actors-turn' | 'action-spent'; hint: string } | undefined {
  if (combat?.activeEntityId && combat.activeEntityId !== actorId)
    return {
      code: 'not-actors-turn',
      hint: `It is ${combat.activeEntityId}'s turn.`,
    };
  if (combat?.resources[actorId]?.action === false)
    return {
      code: 'action-spent',
      hint: 'This creature has already used its action this turn.',
    };
  return undefined;
}

export function spendAction(
  combat: TurnState | undefined,
  actorId: string,
): TurnState | undefined {
  const resources = combat?.resources[actorId];
  if (!combat || !resources) return combat;
  return {
    ...combat,
    resources: {
      ...combat.resources,
      [actorId]: { ...resources, action: false },
    },
  };
}
