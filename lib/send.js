/**
 * 带校验的消息发送。
 *
 * Yunzai 的 Bot.sendGroupMsg / sendFriendMsg 内部 try/catch，出错只写一条日志然后
 * 返回 undefined，不会抛异常。直接 await 会把「没发出去」当成成功，所以统一在这里
 * 检查返回值里的 message_id，拿不到就抛错，让调用方走失败分支（重试 / 不记成功）。
 */

/** 从发送结果里取 message_id（兼容 object / 数组 / 数字 / 字符串几种返回） */
export function messageIdOf(result) {
  if (result === undefined || result === null) return ''
  if (typeof result === 'number' || typeof result === 'string') return String(result)
  const value =
    result.message_id ??
    result.messageId ??
    result.data?.message_id ??
    result.data?.messageId ??
    (Array.isArray(result.data) ? result.data[0]?.message_id : undefined)
  if (Array.isArray(value)) return String(value[0] ?? '')
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 发送一条消息并确认送达。
 * @param {{type: 'group'|'private', id: string}} target
 * @param {any} message 消息段 / 文本
 * @returns {Promise<string>} message_id
 */
export async function sendToTarget(target, message) {
  const bot = globalThis.Bot
  if (!bot) throw new Error('Bot 尚未就绪')
  const result =
    target.type === 'group'
      ? await bot.sendGroupMsg(bot.uin?.[0], target.id, message)
      : await bot.sendFriendMsg(bot.uin?.[0], target.id, message)
  const messageId = messageIdOf(result)
  if (!messageId) throw new Error('发送没有返回 message_id，消息可能并未真正发出')
  return messageId
}
