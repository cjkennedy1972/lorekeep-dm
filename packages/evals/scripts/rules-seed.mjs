// Seed list for the rules dataset: [question, SRD chunk regex, answer keywords that a correct reply must contain].
export default [
  [
    'How many seconds does one combat round represent?',
    'Round.{0,80}6 seconds|6 seconds',
    ['6 seconds'],
  ],
  [
    'What happens if you take damage from a Critical Hit while at 0 Hit Points?',
    'Damage at 0 Hit Points',
    ['two failures'],
  ],
  [
    'What is the DC of a death saving throw?',
    'Death Saving Throw.{0,300}DC 10|DC 10.{0,200}Death',
    ['10'],
  ],
  [
    'What do you regain if you roll a 20 on a Death Saving Throw?',
    'roll a 20 on the d20, you regain',
    ['1 Hit Point'],
  ],
  [
    'What happens when you take any damage while at 0 Hit Points?',
    'Damage at 0 Hit Points',
    ['Death Saving Throw failure'],
  ],
  [
    'How does a creature benefit from the Dodge action?',
    'Dodge \\[Action\\]',
    ['Disadvantage'],
  ],
  [
    'What does the Help action allow when aiding another character?',
    'Help action to aid another',
    ['Utilize'],
  ],
  [
    'How is initiative determined?',
    'Dexterity check|Initiative',
    ['dexterity'],
  ],
  ['What does it cost to stand up from prone?', 'half.{0,40}Speed', ['half']],
  [
    'What attack roll modifier applies to attacks against a prone target from within 5 feet?',
    'Prone.{0,300}Advantage',
    ['advantage'],
  ],
  [
    'How does difficult terrain affect movement?',
    'Difficult Terrain',
    ['extra'],
  ],
  [
    'When does an Opportunity Attack trigger?',
    'Opportunity Attack',
    ['leaves'],
  ],
  [
    'What action does an Opportunity Attack use?',
    'Opportunity Attack.{0,200}Reaction',
    ['reaction'],
  ],
  [
    'How many Death Saving Throw failures does a Critical Hit cause at 0 Hit Points?',
    'Damage at 0 Hit Points',
    ['two'],
  ],
  [
    'What is the benefit of temporary hit points relative to regular hit points?',
    'Temporary Hit Points',
    ['damage'],
  ],
  [
    'Can temporary hit points stack?',
    'Temporary Hit Points.{0,400}(stack|do not add|choose)|don.t stack|do not stack',
    ['not'],
  ],
  [
    'What do advantage and disadvantage do to a d20 roll when both apply?',
    'Advantage and Disadvantage|cancel',
    ['cancel'],
  ],
  [
    'What does the Hide action let you try to do?',
    'Hide \\[Action\\] With the Hide action',
    ['hide yourself'],
  ],
  [
    'What does the Ready action let a creature do?',
    'Ready \\[Action\\]',
    ['Reaction'],
  ],
  [
    'How many Hit Point Dice can be spent during a Short Rest?',
    'Short Rest',
    ['Hit Point Dice'],
  ],
  ['How long is a Short Rest?', 'A Short Rest is a 1-hour', ['1-hour']],
  ['How long is a Long Rest?', 'A Long Rest is a period', ['8 hours']],
  [
    'How many hours of sleep does a Long Rest require?',
    'A Long Rest is a period',
    ['6 hours'],
  ],
  [
    'What happens to your Concentration while you have the Incapacitated condition?',
    'Incapacitated \\[Condition\\]',
    ['Concentration is broken'],
  ],
  [
    'Which condition means you cannot take any action, Bonus Action, or Reaction?',
    'Incapacitated \\[Condition\\]',
    ['Inactive'],
  ],
  [
    'What does the Poisoned condition impose?',
    'Poisoned \\[Condition\\]',
    ['Disadvantage'],
  ],
  [
    "What happens to a Grappled creature's Speed?",
    'Grappled \\[Condition\\]',
    ['Speed'],
  ],
  [
    'How is a Restrained creature affected on attack rolls?',
    'Restrained \\[Condition\\]',
    ['Disadvantage'],
  ],
  [
    'What does the Blinded condition impose on attack rolls?',
    'Blinded \\[Condition\\]',
    ['Disadvantage'],
  ],
  [
    'What is the effect of the Paralyzed condition on attacks within 5 feet?',
    'Paralyzed \\[Condition\\]',
    ['Critical Hit'],
  ],
  [
    "What does the Unconscious condition do to a creature's speed?",
    'Unconscious \\[Condition\\]',
    ['Speed 0'],
  ],
  [
    'What do Resistance and Vulnerability do to damage?',
    'Resistance and Vulnerability|Resistance.{0,200}half',
    ['half'],
  ],
  [
    'How is Resistance applied relative to other modifiers?',
    'Resistance.{0,250}round',
    ['round'],
  ],
  [
    'What does the Incapacitated condition do to Speechless ability?',
    'Incapacitated \\[Condition\\]',
    ['can.t speak'],
  ],
  [
    'What does Surprised mean for an Incapacitated creature rolling Initiative?',
    'Incapacitated \\[Condition\\]',
    ['Disadvantage'],
  ],
  [
    'What happens when the Unconscious condition ends?',
    'Unconscious \\[Condition\\]',
    ['remain Prone'],
  ],
  ['What is a Bonus Action?', 'Bonus Action', ['Bonus Action']],
  [
    'How many Bonus Actions can a creature take per turn?',
    'one Bonus Action|Bonus Action.{0,200}turn',
    ['one'],
  ],
  ['What is a Reaction and when can it be used?', 'Reaction', ['Reaction']],
  [
    'What is a Reaction?',
    'Reactions Certain special abilities',
    ['instant response'],
  ],
  [
    'What does the Light property let you do with a Bonus Action?',
    'Light When you take the Attack action',
    ['extra attack'],
  ],
  [
    'What does the Finesse property let you use for attack and damage rolls?',
    'Finesse When making an attack',
    ['Strength or Dexterity'],
  ],
  ['What does the Reach property do?', 'Reach.{0,100}5 feet', ['5 feet']],
  [
    'What does Heavy do to attack rolls if your Strength is below 13?',
    'Heavy You have Disadvantage',
    ['Disadvantage'],
  ],
  [
    'What does your class features table show for Spellcasting?',
    'Spell Slots, Cantrips, and Prepared Spells',
    ['spell slots'],
  ],
  ['What do ritual spells allow?', 'Ritual', ['Ritual']],
  [
    "How is a creature's Passive Perception calculated?",
    'Passive Perception equals',
    ['10 plus'],
  ],
  ['What does Heroic Inspiration grant?', 'Heroic Inspiration', ['Advantage']],
  [
    'What kind of attack is an Unarmed Strike?',
    'Unarmed Strike Instead of using a weapon',
    ['melee attack'],
  ],
  [
    'What are the six abilities?',
    'Strength.{0,80}Dexterity.{0,80}Constitution',
    ['Strength'],
  ],
];
