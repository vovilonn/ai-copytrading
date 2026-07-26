import { Kysely, sql } from 'kysely'

// Водяной знак обработки канала: с какого сообщения движок вообще берётся за разбор.
//
// ЗАЧЕМ. Живой инцидент (прод, 25.07.2026): на новом сервере каналы засидились с
// `last_seen_message_id = 0`, бэкфилл tg-ingest честно вытянул ВСЮ историю (~3100 сообщений), и
// движок прогнал её через пайплайн как свежую: 2268 вызовов AI на $22.73, а одно сообщение от
// 30 декабря 2025 открыло РЕАЛЬНУЮ позицию на mainnet (TR-1046, DOTUSDT). Гейта «это старьё» не
// существовало: `main.ts::processChannel` выбирает `status='received'` без единого условия на
// возраст, а `pipeline.ts` зовёт AI раньше всех проверок.
//
// ПОЧЕМУ ИМЕННО ВОДЯНОЙ ЗНАК, А НЕ «не обрабатывать то, что пришло бэкфиллом» и не порог возраста:
// - бэкфилл — ШТАТНЫЙ путь доставки ЖИВЫХ сообщений (реконнект MTProto, периодический проход
//   каждые 10 минут). Пометка «пришло бэкфиллом ⇒ не обрабатывать» потеряла бы свежий сигнал
//   «закрываю позицию» после любого разрыва связи;
// - порог возраста не может одновременно «догнать 30 минут даунтайма движка» и «не трогать
//   историю» — это один и тот же диапазон возрастов.
// Признак «до подключения канала / после» ортогонален и времени, и пути доставки — поэтому он
// корректен во всех трёх краевых случаях (движок лежал; отложенный сигнал закрытия; переезд).
//
// СУЩЕСТВУЮЩИЕ БАЗЫ: всё, что уже подтянуто, объявляется историей (watermark = максимальный
// tg_message_id канала). Обрабатываться будет только то, что придёт ПОСЛЕ обновления.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE channels
      ADD COLUMN IF NOT EXISTS process_from_message_id BIGINT NOT NULL DEFAULT 0
  `.execute(db)

  // Комментарий в схеме: смысл колонки должен быть виден тому, кто смотрит на БД, а не только в
  // этом файле (значение сравнивается со СТРОГИМ `>`: watermark — последнее ИСТОРИЧЕСКОЕ сообщение).
  await sql`
    COMMENT ON COLUMN channels.process_from_message_id IS
      'Последнее ИСТОРИЧЕСКОЕ сообщение канала: движок разбирает только tg_message_id > этого значения, остальное помечает archived'
  `.execute(db)

  await sql`
    UPDATE channels c
       SET process_from_message_id = COALESCE((SELECT MAX(m.tg_message_id) FROM messages m WHERE m.channel_id = c.id), 0)
     WHERE c.process_from_message_id = 0
  `.execute(db)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE channels DROP COLUMN IF EXISTS process_from_message_id`.execute(db)
}
