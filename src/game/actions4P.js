// =========================================================
//  actions4P.js — 4 Kişilik Mod Kanonik Mesaj Formatları
//  2P actions.js / 3P actions3P.js'e paralel.
// =========================================================

export const ACTION_TYPES_4P = Object.freeze({
  START_GAME:       'START_GAME',
  ADVANCE_ROUND:    'ADVANCE_ROUND',
  START_BATTLE:     'START_BATTLE',
  REVEAL_BATTLE:    'REVEAL_BATTLE',
  NEXT_BATTLE:      'NEXT_BATTLE',
  PLACE_BID:        'PLACE_BID',
  PASS:             'PASS',
  CHOOSE_FREE_ITEM: 'CHOOSE_FREE_ITEM',
});

export const Actions4P = {
  startGame: (playerNames = {}) => ({
    type: ACTION_TYPES_4P.START_GAME, payload: { playerNames },
  }),

  placeBid: (bidderId, amount) => ({
    type: ACTION_TYPES_4P.PLACE_BID, payload: { bidderId, amount },
  }),

  pass: (passerId) => ({
    type: ACTION_TYPES_4P.PASS, payload: { passerId },
  }),

  /**
   * @param {string} deciderId
   * @param {'take'|'gift'} choice
   * @param {string|null} [giftTargetId] — choice==='gift' ise zorunlu
   */
  chooseFreeItem: (deciderId, choice, giftTargetId = null) => ({
    type: ACTION_TYPES_4P.CHOOSE_FREE_ITEM,
    payload: { deciderId, choice, giftTargetId },
  }),

  advanceRound: () => ({ type: ACTION_TYPES_4P.ADVANCE_ROUND, payload: {} }),
  startBattle:  () => ({ type: ACTION_TYPES_4P.START_BATTLE,  payload: {} }),
  revealBattle: () => ({ type: ACTION_TYPES_4P.REVEAL_BATTLE, payload: {} }),
  nextBattle:   () => ({ type: ACTION_TYPES_4P.NEXT_BATTLE,   payload: {} }),
};

/**
 * @param {import('./GameEngine4P.js').GameEngine4P} engine
 */
export function applyAction4P(engine, action) {
  const { type, payload } = action;

  switch (type) {
    case ACTION_TYPES_4P.START_GAME:
      return engine.startGame(payload.playerNames);
    case ACTION_TYPES_4P.PLACE_BID:
      return engine.placeBid(payload.bidderId, payload.amount);
    case ACTION_TYPES_4P.PASS:
      return engine.pass(payload.passerId);
    case ACTION_TYPES_4P.CHOOSE_FREE_ITEM:
      return engine.chooseFreeItem(payload.deciderId, payload.choice, payload.giftTargetId ?? null);
    case ACTION_TYPES_4P.ADVANCE_ROUND:
      return engine.advanceRound();
    case ACTION_TYPES_4P.START_BATTLE:
      return engine.startBattle();
    case ACTION_TYPES_4P.REVEAL_BATTLE:
      return engine.revealBattle();
    case ACTION_TYPES_4P.NEXT_BATTLE:
      return engine.nextBattle();
    default:
      return { ok: false, error: `Bilinmeyen action tipi: ${type}` };
  }
}
