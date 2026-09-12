// =========================================================
//  actions3P.js — 3 Kişilik Mod Kanonik Mesaj Formatları
//  2 kişilik actions.js'e paralel.
// =========================================================

export const ACTION_TYPES_3P = Object.freeze({
  START_GAME:       'START_GAME',
  ADVANCE_ROUND:    'ADVANCE_ROUND',
  START_BATTLE:     'START_BATTLE',
  REVEAL_BATTLE:    'REVEAL_BATTLE',
  NEXT_BATTLE:      'NEXT_BATTLE',
  PLACE_BID:        'PLACE_BID',
  PASS:             'PASS',
  CHOOSE_FREE_ITEM: 'CHOOSE_FREE_ITEM',
});

export const Actions3P = {
  startGame: (playerNames = {}) => ({
    type: ACTION_TYPES_3P.START_GAME, payload: { playerNames },
  }),

  placeBid: (bidderId, amount) => ({
    type: ACTION_TYPES_3P.PLACE_BID, payload: { bidderId, amount },
  }),

  pass: (passerId) => ({
    type: ACTION_TYPES_3P.PASS, payload: { passerId },
  }),

  /**
   * @param {string} deciderId
   * @param {'take'|'gift'} choice
   * @param {string|null} [giftTargetId] — choice==='gift' ise zorunlu
   */
  chooseFreeItem: (deciderId, choice, giftTargetId = null) => ({
    type: ACTION_TYPES_3P.CHOOSE_FREE_ITEM,
    payload: { deciderId, choice, giftTargetId },
  }),

  advanceRound: () => ({ type: ACTION_TYPES_3P.ADVANCE_ROUND, payload: {} }),
  startBattle:  () => ({ type: ACTION_TYPES_3P.START_BATTLE,  payload: {} }),
  revealBattle: () => ({ type: ACTION_TYPES_3P.REVEAL_BATTLE, payload: {} }),
  nextBattle:   () => ({ type: ACTION_TYPES_3P.NEXT_BATTLE,   payload: {} }),
};

/**
 * @param {import('./GameEngine3P.js').GameEngine3P} engine
 */
export function applyAction3P(engine, action) {
  const { type, payload } = action;

  switch (type) {
    case ACTION_TYPES_3P.START_GAME:
      return engine.startGame(payload.playerNames);
    case ACTION_TYPES_3P.PLACE_BID:
      return engine.placeBid(payload.bidderId, payload.amount);
    case ACTION_TYPES_3P.PASS:
      return engine.pass(payload.passerId);
    case ACTION_TYPES_3P.CHOOSE_FREE_ITEM:
      return engine.chooseFreeItem(payload.deciderId, payload.choice, payload.giftTargetId ?? null);
    case ACTION_TYPES_3P.ADVANCE_ROUND:
      return engine.advanceRound();
    case ACTION_TYPES_3P.START_BATTLE:
      return engine.startBattle();
    case ACTION_TYPES_3P.REVEAL_BATTLE:
      return engine.revealBattle();
    case ACTION_TYPES_3P.NEXT_BATTLE:
      return engine.nextBattle();
    default:
      return { ok: false, error: `Bilinmeyen action tipi: ${type}` };
  }
}
