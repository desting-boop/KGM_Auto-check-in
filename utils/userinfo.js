/**
 * USERINFO 读取与持久化。
 *
 * 设计目标（针对旧流程的致命问题）：
 *   旧流程把「写 secret」当成登录的硬性前提，且写失败只打印警告，
 *   于是 Actions 显示 success、USERINFO 实际从未写入，
 *   后续每天的签到全部以「未配置」秒退 —— 连续 88 次失败却查不出原因。
 *
 * 新流程的取舍：
 *   1. 签到（main.js）只读 secrets.USERINFO，运行时由 GITHUB_TOKEN 注入，
 *      **核心签到链路完全不依赖 PAT**。
 *   2. 写入 USERINFO 时优先用 PAT 自动写；没有 PAT 或写失败，
 *      改为在日志中输出可复制的字符串，由用户手动粘进 Secret。
 *      此时登录任务依然算「成功」——因为登录本身确实成功了，
 *      剩下的只是搬运工作，不该让任务变红。
 *   3. token 刷新写回同理：有 PAT 才自动写，没有就明确提示用户手动更新。
 */

import { printBlue, printGreen, printRed, printYellow } from './colorOut.js'
import { hasSecretWriteToken, setRepoSecret } from './githubSecrets.js'
import { maskIdentifier, sanitizeForLog, shouldPrintSensitiveValue } from './safeLog.js'

/**
 * 解析 USERINFO 环境变量。
 * @returns {Array<{userid: string, token: string}>}
 */
function readUserinfo() {
  const raw = process.env.USERINFO
  if (!raw || !raw.trim()) {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      `Secret USERINFO 不是合法 JSON：${e.message}\n` +
      `请确认内容形如：[{"userid":"123","token":"abc"}]（不要带多余引号或换行）`
    )
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Secret USERINFO 必须是 JSON 数组，例如：[{"userid":"123","token":"abc"}]')
  }
  const valid = parsed.filter(u => u && u.userid && u.token)
  if (valid.length !== parsed.length) {
    printYellow(`已忽略 ${parsed.length - valid.length} 条缺少 userid/token 的记录`)
  }
  return valid
}

/**
 * 将登录用户信息更新或追加到 userinfo 数组中。
 * @param {Array} userinfo 用户信息数组（会被就地修改）
 * @param {{userid: string, token: string}} loginUser 新登录的用户
 * @param {boolean} append 是否追加模式（已存在则更新，否则添加）
 */
function upsertUser(userinfo, loginUser, append) {
  if (append) {
    for (const u of userinfo) {
      if (u.userid == loginUser.userid) {
        printYellow(`userid: ${maskIdentifier(u.userid)} 此账号已存在, 仅更新登录信息`)
        u.token = loginUser.token
        return
      }
    }
  }
  userinfo.push({ userid: loginUser.userid, token: loginUser.token })
}

/**
 * 保存 userinfo 到 GitHub Secret。
 *
 * 关键行为：写失败 **不抛错**。登录本身已成功，
 * 搬运到 Secret 是可选的增强步骤，失败时降级为「输出可复制的字符串」。
 *
 * @param {Array} userinfo 用户信息数组
 * @returns {{persisted: boolean, reason: string}} 是否成功持久化及原因
 */
function saveUserinfo(userinfo) {
  if (!userinfo || !userinfo.length) {
    return { persisted: false, reason: '无账号信息' }
  }

  const userinfoJSON = JSON.stringify(userinfo)

  if (hasSecretWriteToken()) {
    try {
      setRepoSecret('USERINFO', userinfoJSON)
      printGreen('✅ secret <USERINFO> 已自动写入')
      return { persisted: true, reason: '' }
    } catch (error) {
      printRed('⚠️ 自动写入 secret <USERINFO> 失败：' + (error && error.message ? error.message : error))
      console.dir(sanitizeForLog({ message: error && error.message ? error.message : String(error) }), { depth: null })
      printYellow('常见原因：PAT 令牌类型不对。')
      printYellow('  · fine-grained PAT（github.com/settings/personal-access-tokens/new）写 secret 会报 403')
      printYellow('  · 请改用 classic PAT：github.com/settings/tokens ，勾选 repo 权限')
      printManualCopyHint(userinfoJSON)
      return { persisted: false, reason: 'PAT 写入失败' }
    }
  }

  printYellow('未配置 PAT，无法自动写入 secret <USERINFO>（不影响签到运行）')
  printManualCopyHint(userinfoJSON)
  return { persisted: false, reason: '未配置 PAT' }
}

/**
 * 提示用户手动复制 USERINFO 到 Secret。
 */
function printManualCopyHint(userinfoJSON) {
  if (shouldPrintSensitiveValue()) {
    printGreen('请把下面这行完整复制，粘贴到 Settings → Secrets and variables → Actions → USERINFO：')
    printBlue(userinfoJSON)
    printYellow('注意：日志包含登录 token，粘贴完成后请删除本次运行日志')
  } else {
    printYellow('为避免泄露 token，默认不在日志输出 USERINFO')
    printYellow('如需手动复制，请重新运行并把 print_userinfo 选为 是')
  }
}

export { readUserinfo, upsertUser, saveUserinfo, printManualCopyHint }
