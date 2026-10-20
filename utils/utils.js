import { spawn } from 'child_process'

/** 延时 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等待本地 API 服务就绪（修复冷启动竞态）。
 *
 * 背景：旧实现 startService() 后固定 delay(2000) 就发第一个请求。
 * 实测冷启动时服务实际就绪需要 ~2.8s，2 秒根本不够，
 * 首个请求必然 ECONNREFUSED，导致整个任务失败。
 * 改为轮询探测：端口能返回任意 HTTP 响应即视为已就绪。
 *
 * @param {string} base 服务地址
 * @param {number} timeoutMs 最长等待毫秒
 */
async function waitForApi(base = 'http://127.0.0.1:3000', timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const resp = await fetch(base + '/user/detail', { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      // 任意 HTTP 响应（含 4xx/5xx）都说明服务已在监听端口
      return true
    } catch (err) {
      // 连接被拒（ECONNREFUSED）等服务尚未就绪，稍后重试
      await delay(500)
    }
  }
  throw new Error(`本地 API 服务在 ${timeoutMs}ms 内未就绪`)
}

/**
 * 启动 api 服务。
 *
 * 关键修复 1：不再因子进程 stderr 有输出就 throw。
 *   旧实现 `api.stderr.on('data', () => { throw ... })` —— 任何一行 stderr
 *   （npm 警告、node 弃用提示、apt 输出等）都会让主进程直接崩溃退出。
 * 关键修复 2：detached 使子进程成为独立进程组，便于后续整组强杀。
 */
function startService() {
  const isWindows = process.platform === 'win32'
  const api = spawn('npm', ['run', 'apiService'], {
    detached: !isWindows,
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  api.stdout.on('data', () => {})
  api.stderr.on('data', data => {
    const msg = String(data).trim()
    if (msg) console.log(`[api stderr] ${msg}`)
  })
  api.on('close', code => console.log(`[api] 子进程退出，code=${code}`))

  return api
}

/**
 * 关闭 api 服务。
 *
 * 关键修复：npm 不会把信号转发给它的子进程（真正的 Express 服务），
 * 仅 api.kill() 会导致 3000 端口一直被占 → 下一阶段 startService 报 EADDRINUSE。
 * 因此用 detached 进程组 + process.kill(-pid) 强杀整组。
 */
function close_api(api) {
  if (!api || !api.pid) return
  try {
    process.kill(-api.pid, 'SIGKILL') // 杀掉整个进程组（npm + Express）
  } catch (e) {
    try { api.kill('SIGKILL') } catch (_) { /* 已退出 */ }
  }
}

/**
 * 发送请求到本地 api 服务（带超时 + 指数退避重试）。
 *
 * 关键修复：旧实现单次 fetch，无超时无重试，
 * 一次网络抖动就让整个签到任务失败。
 */
async function send(path, method, headers) {
  const MAX_RETRIES = 3
  const TIMEOUT_MS = 10000
  let lastError

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch('http://127.0.0.1:3000' + path, {
        method,
        headers,
        signal: controller.signal,
      })
      clearTimeout(timer)
      return await resp.json()
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt < MAX_RETRIES - 1) {
        const waitMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
        console.log(`[send] 第 ${attempt + 1} 次请求失败，${waitMs}ms 后重试: ${err.message}`)
        await delay(waitMs)
      }
    }
  }
  throw lastError
}

export { delay, startService, close_api, send, waitForApi }
