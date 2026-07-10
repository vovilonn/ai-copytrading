import { describe, it, expect } from 'vitest'
import { topicOf } from '../src/topic-filter.js'

const TOPIC = 173666

it('221445 — настоящий ответ: replyToTopId заполнен', () => {
  expect(topicOf({ forumTopic: true, replyToMsgId: 221443, replyToTopId: TOPIC }, TOPIC)).toBe('reply')
})

it('221452 — обычный пост в топик: replyToTopId пуст', () => {
  expect(topicOf({ forumTopic: true, replyToMsgId: TOPIC, replyToTopId: null }, TOPIC)).toBe('root')
})

it('сообщение чужого топика отбрасывается', () => {
  expect(topicOf({ forumTopic: true, replyToMsgId: 999, replyToTopId: 111 }, TOPIC)).toBe('other')
})

it('сообщение не из форума отбрасывается', () => {
  expect(topicOf({ forumTopic: false, replyToMsgId: TOPIC, replyToTopId: null }, TOPIC)).toBe('other')
})

it('отсутствие replyTo отбрасывается', () => {
  expect(topicOf(null, TOPIC)).toBe('other')
})
