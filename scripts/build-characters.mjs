// 手动更新女武神数据库：npm run update:data
// 日常无需手动执行——插件启动后会自动检查 data/characters.json，缺失或超过 7 天时在后台更新
import { updateCharacterData } from '../lib/characterUpdater.js'

const result = await updateCharacterData({ logger: console })
if (!result.ok) {
  console.error(`更新失败：${result.reason || '未知原因'}`)
  process.exitCode = 1
} else {
  console.log(`完成：${result.count} 名女武神（失败 ${result.failed} 个），已写入 data/characters.json`)
}
