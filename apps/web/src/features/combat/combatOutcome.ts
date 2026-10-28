/** Player-facing copy for a server `CombatEnded` outcome. Unknown outcomes stay neutral. */
export function combatOutcomeCopy(outcome: string | undefined): {
  title: string;
  body: string;
} {
  switch (outcome) {
    case 'party-victory':
      return { title: 'Victory', body: 'The last enemy is down.' };
    case 'enemies-fled':
      return { title: 'Retreat', body: 'The enemies fled the field.' };
    case 'party-defeated':
      return { title: 'Defeat', body: 'The party has fallen.' };
    case 'dm-ended':
      return {
        title: 'Encounter ended',
        body: 'The storyteller ended the encounter.',
      };
    default:
      return { title: 'Combat over', body: 'The fight has ended.' };
  }
}
