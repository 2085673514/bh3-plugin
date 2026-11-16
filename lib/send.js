/**
 * 带校验的消息发送。
 *
 * 两个坑都在这里兜住：
 * 1. Yunzai 的 Bot.sendGroupMsg / sendFriendMsg 内部 try/catch，出错只写一条日志然后
 *    返回 undefined，不会抛异常 —— 直接 await 会把「没发出去」当成成功。
 * 2. Bot.uin[0] 不一定是真的 QQ 账号：stdin（标准输入）适配器也会注册成 bot，
 *    抢到下标 0 时消息只会被打印到控制台（data/stdin/ 里留一张图，并返回一个
 *    Date.now().toString(36) 的假 message_id），看起来「发送成功」，实际群里什么都没有。
 *
 * 所以发送前先挑一个真实的数字账号（优先挑真的在这个群里的），拿不到 message_id 就抛错。
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

/** 这个 bot 是否真的在目标群里（gl 的 key 可能是 string 也可能是 number） */
function botInGroup(botInstance, groupId) {
  const gl = botInstance?.gl
  if (!gl || typeof gl.has !== 'function') return false
  if (gl.has(groupId)) return true
  for (const key of gl.keys()) {
    if (String(key) === String(groupId)) return true
  }
  return false
}

/**
 * 挑一个能真正发消息的 bot 账号。
 * 排除 stdin 这类控制台虚拟账号，只认真实的 QQ 号；群消息优先挑在群里的那个。
 */
export function pickBotId(target = {}) {
  const bot = globalThis.Bot
  if (!bot) return undefined
  const ids = Array.isArray(bot.uin) ? Array.from(bot.uin).map(String) : []
  // 真实 QQ 号：纯数字，且 Bot.bots 里确有实例
  const real = ids.filter(id => /^\d{5,12}$/.test(id) && bot.bots?.[id])
  if (target.type === 'group' && target.id) {
    const inGroup = real.find(id => botInGroup(bot.bots[id], target.id))
    if (inGroup) return inGroup
  }
  return real[0]
}

/**
 * 发送一条消息并确认送达。
 * @param {{type: 'group'|'private', id: string}} target
 * @param {any} message 消息段 / 文本
 * @returns {Promise<{messageId: string, botId: string}>}
 */
export async function sendToTarget(target, message) {
  const bot = globalThis.Bot
  if (!bot) throw new Error('Bot 尚未就绪')
  const botId = pickBotId(target)
  // 只剩下 stdin 之类的控制台账号时，宁可报错重试，也不能把消息打印到控制台当成功
  if (!botId) throw new Error('没有已连接的 QQ 账号，无法发送')
  const result =
    target.type === 'group'
      ? await bot.sendGroupMsg(botId, target.id, message)
      : await bot.sendFriendMsg(botId, target.id, message)
  const messageId = messageIdOf(result)
  if (!messageId) throw new Error('发送没有返回 message_id，消息可能并未真正发出')
  return { messageId, botId }
}
