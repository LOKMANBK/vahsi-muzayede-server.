// =========================================================
//  ACTIONS — Kanonik Mesaj Formatları
//
//  Hem istemci→sunucu hem sunucu→istemci bu formatı kullanır.
//  Sunucu bu action'ları alır, engine'e uygular, yeni state'i yayar.
//
//  Kurallar:
//  - Her action plain JSON-serializable obje
//  - type: string sabit (ACTION_TYPES)
//  - payload: action'a özgü veriler
//  - meta: gameId, playerId gibi routing bilgileri
// =========================================================

// ── Action Tipleri ────────────────────────────────────────

export const ACTION_TYPES = Object.freeze({
  // Oyun akışı
  START_GAME:    'START_GAME',
  ADVANCE_ROUND: 'ADVANCE_ROUND',
  START_BATTLE:  'START_BATTLE',
  REVEAL_BATTLE: 'REVEAL_BATTLE',
  NEXT_BATTLE:   'NEXT_BATTLE',

  // Müzayede
  PLACE_BID: 'PLACE_BID',
  PASS:      'PASS',

  // Rakip parasız kaldığında: teklif verebilen oyuncu karar veriyor
  CHOOSE_FREE_ITEM: 'CHOOSE_FREE_ITEM',
});

// ── Action Yapıcılar (Factory Functions) ─────────────────
// Kullanım: dispatch(Actions.placeBid('player1', 8))

export const Actions = {
  startGame: (playerNames = {}) => ({
    type:    ACTION_TYPES.START_GAME,
    payload: { playerNames },
  }),

  placeBid: (bidderId, amount) => ({
    type:    ACTION_TYPES.PLACE_BID,
    payload: { bidderId, amount },
  }),

  pass: (passerId) => ({
    type:    ACTION_TYPES.PASS,
    payload: { passerId },
  }),

  /**
   * @param {string} deciderId — teklif verebilen oyuncu
   * @param {'take'|'pass'} choice — 'take': bedava alır, 'pass': parasız rakibe bırakır
   */
  chooseFreeItem: (deciderId, choice) => ({
    type:    ACTION_TYPES.CHOOSE_FREE_ITEM,
    payload: { deciderId, choice },
  }),

  advanceRound: () => ({
    type:    ACTION_TYPES.ADVANCE_ROUND,
    payload: {},
  }),

  startBattle: () => ({
    type:    ACTION_TYPES.START_BATTLE,
    payload: {},
  }),

  revealBattle: () => ({
    type:    ACTION_TYPES.REVEAL_BATTLE,
    payload: {},
  }),

  nextBattle: () => ({
    type:    ACTION_TYPES.NEXT_BATTLE,
    payload: {},
  }),
};

// ── Action Uygulayıcı (Engine → Action köprüsü) ──────────

/**
 * Bir action'ı GameEngine üzerinde uygular.
 * Sunucu ve LocalTransport bu fonksiyonu kullanır.
 * Engine'i doğrudan çağırmaktan bu fonksiyonu tercih et —
 * tüm action→method eşlemesi tek yerde.
 *
 * @param {GameEngine} engine
 * @param {Action}     action
 * @returns {{ ok: boolean, event?: GameEvent, error?: string }}
 */
export function applyAction(engine, action) {
  const { type, payload } = action;

  switch (type) {
    case ACTION_TYPES.START_GAME:
      return engine.startGame(payload.playerNames);

    case ACTION_TYPES.PLACE_BID:
      return engine.placeBid(payload.bidderId, payload.amount);

    case ACTION_TYPES.PASS:
      return engine.pass(payload.passerId);

    case ACTION_TYPES.CHOOSE_FREE_ITEM:
      return engine.chooseFreeItem(payload.deciderId, payload.choice);

    case ACTION_TYPES.ADVANCE_ROUND:
      return engine.advanceRound();

    case ACTION_TYPES.START_BATTLE:
      return engine.startBattle();

    case ACTION_TYPES.REVEAL_BATTLE:
      return engine.revealBattle();

    case ACTION_TYPES.NEXT_BATTLE:
      return engine.nextBattle();

    default:
      return { ok: false, error: `Bilinmeyen action tipi: ${type}` };
  }
}
