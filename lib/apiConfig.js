/**
 * 米游社接口公共配置（盐 / 客户端版本 / UA）集中管理。
 *
 * 说明：记录接口、手账接口、genAuthKey 接口由米游社不同网关校验，
 * 历史上各自使用不同版本的 x-rpc-app_version。这里统一命名并注明用途，
 * 升级时只改本文件；不要在业务代码里再散落版本号。
 */

/** 记录接口 DS 盐（App 端） */
export const SALT_RECORD = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
/** 网页接口 DS 盐（getUserGameRolesByCookie） */
export const SALT_WEB = 'yBh10ikxtLPoIhgwgPZSv5dmfaOTSJ6a'
/** genAuthKey 网页 DS 盐 */
export const SALT_WEB_AUTHKEY = 'WGtruoQrwczmsjLOPXzJLnaAYycsLavx'

/** 记录接口（lib/api.js）客户端版本 */
export const APP_VERSION_RECORD = '2.102.1'
/** 记录接口（lib/mys/api.js，honkai-mys 移植层）客户端版本，与旧版签名保持一致 */
export const APP_VERSION_MYS = '2.40.1'
/** genAuthKey 接口客户端版本 */
export const APP_VERSION_AUTHKEY = '2.73.1'

/** 记录接口 UA（随版本号） */
export const UA_RECORD = `Mozilla/5.0 (Linux; Android 13; PHK110 Build/SKQ1.221119.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.133 Mobile Safari/537.36 miHoYoBBS/${APP_VERSION_RECORD}`
/** honkai-mys 移植层 UA */
export const UA_MYS = `Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) miHoYoBBS/${APP_VERSION_MYS}`
/** 网页端 UA（手账接口需要） */
export const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
/** 自助查询接口 UA */
export const UA_SELFHELP = 'Mozilla/5.0 (Linux; Android 13) miHoYoBBS/2.109.0'

/** 进程级随机 device_id（原先写死，容易被风控识别） */
export const DEVICE_ID = Array.from({ length: 32 }, () =>
  '0123456789abcdef'[Math.floor(Math.random() * 16)],
).join('')
