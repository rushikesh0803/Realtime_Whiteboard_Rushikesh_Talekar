// src/lib/ai.js
import { postJson } from './api'

/** Chat with server AI route */
export async function aiChat(messages, model) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages[] required')
  }
  const res = await postJson('/api/ai/chat', { messages, model })
  if (!res?.ok) throw new Error(res?.error || 'AI failed')
  return res
}
