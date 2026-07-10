export interface ReplyHeaderLike {
  forumTopic?: boolean
  replyToMsgId?: number | null
  replyToTopId?: number | null
}

/**
 * Различает корневой пост в топике и ответ на конкретное сообщение внутри него.
 *
 * Надёжный признак — replyToTopId: Telegram проставляет его тогда и только тогда,
 * когда отвечают на сообщение ВНУТРИ топика. У обычного поста в ветку он пуст,
 * а replyToMsgId равен id самого топика.
 */
export function topicOf(
  replyTo: ReplyHeaderLike | null | undefined,
  topicId: number,
): 'root' | 'reply' | 'other' {
  if (!replyTo?.forumTopic) return 'other'
  const actualTopic = replyTo.replyToTopId ?? replyTo.replyToMsgId
  if (actualTopic !== topicId) return 'other'
  return replyTo.replyToTopId == null ? 'root' : 'reply'
}
