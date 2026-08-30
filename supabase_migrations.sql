-- =========================================================
--  Vahşi Müzayede — Supabase Migration Dosyası
--
--  Bu dosyayı Supabase Dashboard → SQL Editor'a yapıştırın
--  veya Supabase CLI ile çalıştırın:
--    supabase db push
--
--  İçerik:
--  1. match_history — room_id UNIQUE constraint (çift kayıt önleme)
--  2. RLS (Row Level Security) kuralları
--  3. İndeksler (sorgu performansı)
--  4. Veritabanı şema açıklaması
-- =========================================================

-- ─── 1. Tablo Şeması (yoksa oluştur) ─────────────────────
--
-- Mevcut tablo varsa bu blok zararsız biçimde atlanır.
-- Yoksa tablolar buradan oluşturulur.

CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    TEXT        NOT NULL UNIQUE,
  xp          INTEGER     NOT NULL DEFAULT 0,
  wins        INTEGER     NOT NULL DEFAULT 0,
  losses      INTEGER     NOT NULL DEFAULT 0,
  level       INTEGER     NOT NULL DEFAULT 1,
  mmr         INTEGER     NOT NULL DEFAULT 1000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       TEXT        NOT NULL,           -- oyun odası ID (sunucu üretir)
  player1_id    UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  player2_id    UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  winner_id     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  p1_score      SMALLINT    NOT NULL DEFAULT 0,
  p2_score      SMALLINT    NOT NULL DEFAULT 0,
  p1_mmr_change SMALLINT    NOT NULL DEFAULT 0,
  p2_mmr_change SMALLINT    NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS friendships (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  addressee   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requester, addressee)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_id     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  type        TEXT        NOT NULL,
  data        JSONB,
  related_id  UUID,
  read        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 2. match_history UNIQUE constraint ──────────────────
--
-- Sunucu #enterFinished'da idempotency guard eklendi; ancak
-- veritabanı katmanında da aynı room_id için iki satır oluşmasını
-- engellemek güvenli savunma derinliği sağlar.
--
-- ON CONFLICT DO NOTHING: sunucu ikinci kez yazarsa hata yerine
-- sessizce atlar — idempotent davranış garantilenir.

ALTER TABLE match_history
  ADD CONSTRAINT IF NOT EXISTS match_history_room_id_unique
  UNIQUE (room_id);

-- Upsert örneği (sunucu kodu bu şekilde güncellenebilir):
-- INSERT INTO match_history (...) VALUES (...)
-- ON CONFLICT (room_id) DO NOTHING;

-- ─── 3. İndeksler ────────────────────────────────────────

-- Kullanıcının maç geçmişini hızlı getir
CREATE INDEX IF NOT EXISTS idx_match_history_player1
  ON match_history (player1_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_match_history_player2
  ON match_history (player2_id, created_at DESC);

-- Bildirim sorguları
CREATE INDEX IF NOT EXISTS idx_notifications_user_id
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id, read) WHERE read = FALSE;

-- Arkadaşlık sorguları
CREATE INDEX IF NOT EXISTS idx_friendships_requester
  ON friendships (requester);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee
  ON friendships (addressee);

-- ─── 4. RLS (Row Level Security) ─────────────────────────
--
-- Her tablo için RLS açılır ve politikalar eklenir.
-- Sunucu, SUPABASE_SERVICE_KEY kullandığında RLS bypass eder —
-- bu nedenle sunucu yazmaları için ayrı politika gerekmez.
-- İstemci (Supabase anon key) sadece kendi verilerini görmeli.

ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- profiles: Herkes profilleri okuyabilir (leaderboard, arama)
DROP POLICY IF EXISTS "profiles_select_public" ON profiles;
CREATE POLICY "profiles_select_public" ON profiles
  FOR SELECT USING (true);

-- profiles: Sadece kendi profilini güncelleyebilir
-- (İstatistik güncellemeleri service_role ile yapılıyor → bu politika istemci güncellemeyi engeller)
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (
    -- Kullanıcı yalnızca username'ini güncelleyebilir; xp/wins/mmr sunucu tarafından yönetilir
    -- Bu politika istemci UPDATE'lerini devre dışı bırakır: sunucu her zaman service_role kullanır.
    false
  );

-- profiles: Kayıt sırasında kendi satırını oluşturur (trigger ile yapılıyorsa gereksiz)
DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- match_history: Kullanıcı kendi maçlarını görebilir
DROP POLICY IF EXISTS "match_history_select_own" ON match_history;
CREATE POLICY "match_history_select_own" ON match_history
  FOR SELECT USING (
    auth.uid() = player1_id OR auth.uid() = player2_id
  );

-- match_history: INSERT/UPDATE/DELETE yalnızca service_role (sunucu)
-- RLS + no istemci policy → istemci yazamaz

-- friendships: Kendi arkadaşlıklarını görebilir
DROP POLICY IF EXISTS "friendships_select_own" ON friendships;
CREATE POLICY "friendships_select_own" ON friendships
  FOR SELECT USING (
    auth.uid() = requester OR auth.uid() = addressee
  );

-- friendships: Arkadaşlık isteği gönderebilir (requester = kendisi)
DROP POLICY IF EXISTS "friendships_insert_own" ON friendships;
CREATE POLICY "friendships_insert_own" ON friendships
  FOR INSERT WITH CHECK (auth.uid() = requester);

-- friendships: Kendi isteğini güncelleyebilir (status değiştirme)
DROP POLICY IF EXISTS "friendships_update_own" ON friendships;
CREATE POLICY "friendships_update_own" ON friendships
  FOR UPDATE USING (auth.uid() = requester OR auth.uid() = addressee);

-- friendships: Kendi ilişkisini silebilir
DROP POLICY IF EXISTS "friendships_delete_own" ON friendships;
CREATE POLICY "friendships_delete_own" ON friendships
  FOR DELETE USING (auth.uid() = requester OR auth.uid() = addressee);

-- notifications: Kendi bildirimlerini görebilir
DROP POLICY IF EXISTS "notifications_select_own" ON notifications;
CREATE POLICY "notifications_select_own" ON notifications
  FOR SELECT USING (auth.uid() = user_id);

-- notifications: Kendi bildirimlerini güncelleyebilir (read=true yapma)
DROP POLICY IF EXISTS "notifications_update_own" ON notifications;
CREATE POLICY "notifications_update_own" ON notifications
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- notifications: Kendi bildirimlerini silebilir
DROP POLICY IF EXISTS "notifications_delete_own" ON notifications;
CREATE POLICY "notifications_delete_own" ON notifications
  FOR DELETE USING (auth.uid() = user_id);

-- ─── 5. Profil Otomatik Oluşturma (trigger) ──────────────
--
-- Kullanıcı kayıt olduğunda profiles tablosuna otomatik satır ekler.
-- Bu trigger sayesinde "profiles_insert_own" politikası gereksiz hale gelir.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER   -- auth.users'a erişim için
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', 'Oyuncu' || substr(NEW.id::text, 1, 6))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─── 6. Kullanışlı RPC Fonksiyonları ─────────────────────

-- notify_user: Sunucu, service_role ile kullanıcıya bildirim atar.
-- RLS'i bypass etmek için SECURITY DEFINER kullanılır.
CREATE OR REPLACE FUNCTION notify_user(
  target   UUID,
  ntype    TEXT,
  ndata    JSONB   DEFAULT '{}',
  related  UUID    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO notifications (user_id, type, data, related_id)
  VALUES (target, ntype, ndata, related);
END;
$$;

-- ─── TAMAMLANDI ──────────────────────────────────────────
-- Bu migration'ı çalıştırdıktan sonra Supabase Dashboard'dan
-- Table Editor → RLS sekmesinde politikaları doğrulayın.
