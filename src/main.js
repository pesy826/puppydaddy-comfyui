'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const VIEW_ID = 'com.puppydaddy.comfyui.console'
const REQUEST_CHANNEL = 'comfyui.request'
const STATE_CHANNEL = 'comfyui.state'
const LOG_CHANNEL = 'comfyui.log'
const RESULT_CHANNEL = 'comfyui.result'

const CONFIG_FILE = 'config.json'
const MAX_PATH_LENGTH = 2048
const MAX_LOG_LINES = 1200
const MAX_LOG_CHARS = 256 * 1024
const MAX_LOG_CHUNK = 12 * 1024
const MAX_SNAPSHOT_LOG_CHARS = 40 * 1024
const STOP_TIMEOUT_MS = 8000
const READY_POLL_MS = 1000

let context = null
let child = null
let generation = 0
let operationTail = Promise.resolve()
let pollTimer = null
let logLines = []
let logChars = 0
let state = {
  phase: 'stopped',
  pid: null,
  ready: false,
  rootPath: '',
  launchKind: null,
  url: null,
  port: 8188,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  error: null,
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000)
}

function snapshotLogs() {
  const selected = []
  let chars = 0
  for (let index = logLines.length - 1; index >= 0; index -= 1) {
    const entry = logLines[index]
    if (selected.length && chars + entry.text.length > MAX_SNAPSHOT_LOG_CHARS) {
      break
    }
    selected.unshift({ ...entry })
    chars += entry.text.length
  }
  return selected
}

function cloneState() {
  return {
    ...state,
    // Host/view 单条消息硬限 64 KiB；完整内存日志可更大，但快照只携带
    // 最近 40 KiB，后续增量继续走 comfyui.log。
    logs: snapshotLogs(),
  }
}

function post(channel, payload) {
  if (!context) return
  context.postViewMessage(VIEW_ID, channel, payload)
}

function publishState() {
  post(STATE_CHANNEL, cloneState())
}

function result(requestId, ok, message) {
  post(RESULT_CHANNEL, {
    requestId:
      typeof requestId === 'string' ? requestId.slice(0, 100) : '',
    ok,
    message: String(message || '').slice(0, 2000),
  })
}

function appendLog(stream, text) {
  const normalized = String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
  if (!normalized) return

  const chunks = []
  for (let offset = 0; offset < normalized.length; offset += MAX_LOG_CHUNK) {
    chunks.push(normalized.slice(offset, offset + MAX_LOG_CHUNK))
  }

  for (const chunk of chunks) {
    const entry = {
      seq: Date.now() * 1000 + Math.floor(Math.random() * 1000),
      ts: Date.now(),
      stream,
      text: chunk,
    }
    logLines.push(entry)
    logChars += chunk.length
    while (
      logLines.length > MAX_LOG_LINES ||
      logChars > MAX_LOG_CHARS
    ) {
      const removed = logLines.shift()
      if (!removed) break
      logChars -= removed.text.length
    }
    post(LOG_CHANNEL, entry)
  }
}

function configPath() {
  return path.join(context.storagePath, CONFIG_FILE)
}

function normalizePort(value) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('端口必须是 1024-65535 的整数')
  }
  return port
}

function normalizeRoot(value) {
  if (typeof value !== 'string') throw new Error('ComfyUI 路径必须是字符串')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH || trimmed.includes('\u0000')) {
    throw new Error('ComfyUI 路径为空或超过安全长度')
  }
  const resolved = path.resolve(trimmed)
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('ComfyUI 路径必须是普通目录，不能是符号链接')
  }
  return resolved
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return {
      rootPath:
        typeof parsed.rootPath === 'string' ? parsed.rootPath : '',
      port:
        Number.isSafeInteger(parsed.port) &&
        parsed.port >= 1024 &&
        parsed.port <= 65535
          ? parsed.port
          : 8188,
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { rootPath: '', port: 8188 }
    appendLog('system', `配置读取失败，已使用默认值：${safeError(error)}\n`)
    return { rootPath: '', port: 8188 }
  }
}

function writeConfig(config) {
  fs.mkdirSync(context.storagePath, { recursive: true })
  const target = configPath()
  const temporary = path.join(
    context.storagePath,
    `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`,
  )
  const content = `${JSON.stringify(config, null, 2)}\n`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Best effort.
      }
    }
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // Best effort.
    }
  }
}

function ordinaryFile(file) {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function discoverLaunch(rootValue) {
  const root = normalizeRoot(rootValue)
  const isWindows = process.platform === 'win32'
  const candidates = []

  const portableMain = path.join(root, 'ComfyUI', 'main.py')
  if (isWindows) {
    candidates.push({
      kind: 'windows-portable',
      executable: path.join(root, 'python_embeded', 'python.exe'),
      main: portableMain,
      cwd: path.join(root, 'ComfyUI'),
      extraArgs: ['--windows-standalone-build'],
    })
  }

  const directMain = path.join(root, 'main.py')
  if (isWindows) {
    candidates.push(
      {
        kind: 'venv',
        executable: path.join(root, '.venv', 'Scripts', 'python.exe'),
        main: directMain,
        cwd: root,
        extraArgs: [],
      },
      {
        kind: 'venv',
        executable: path.join(root, 'venv', 'Scripts', 'python.exe'),
        main: directMain,
        cwd: root,
        extraArgs: [],
      },
      {
        kind: 'bundled-python',
        executable: path.join(root, 'python.exe'),
        main: directMain,
        cwd: root,
        extraArgs: [],
      },
    )
  } else {
    candidates.push(
      {
        kind: 'venv',
        executable: path.join(root, '.venv', 'bin', 'python'),
        main: directMain,
        cwd: root,
        extraArgs: [],
      },
      {
        kind: 'venv',
        executable: path.join(root, 'venv', 'bin', 'python'),
        main: directMain,
        cwd: root,
        extraArgs: [],
      },
    )
  }

  const selected = candidates.find(
    (candidate) =>
      ordinaryFile(candidate.executable) && ordinaryFile(candidate.main),
  )
  if (selected) return { ...selected, root }

  if (ordinaryFile(directMain)) {
    return {
      kind: 'system-python',
      executable: isWindows ? 'python.exe' : 'python3',
      main: directMain,
      cwd: root,
      extraArgs: [],
      root,
    }
  }

  throw new Error(
    '未找到可启动的 ComfyUI。请选择包含 main.py 的 ComfyUI 目录，或 Windows portable 的上级目录。',
  )
}

function safeEnvironment() {
  const retained = [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'PATH',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
    'CUDA_PATH',
  ]
  const env = {}
  for (const key of retained) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.PYTHONUNBUFFERED = '1'
  return env
}

function clearReadyPoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function probeReady(runGeneration) {
  clearReadyPoll()
  if (!child || generation !== runGeneration || state.phase !== 'running') return
  const request = http.get(
    {
      hostname: '127.0.0.1',
      port: state.port,
      path: '/system_stats',
      timeout: 800,
      agent: false,
    },
    (response) => {
      response.resume()
      if (
        child &&
        generation === runGeneration &&
        response.statusCode &&
        response.statusCode >= 200 &&
        response.statusCode < 500
      ) {
        if (!state.ready) {
          state.ready = true
          appendLog('system', `ComfyUI API 已就绪：${state.url}\n`)
          publishState()
        }
        return
      }
      pollTimer = setTimeout(() => probeReady(runGeneration), READY_POLL_MS)
    },
  )
  request.on('timeout', () => request.destroy())
  request.on('error', () => {
    if (child && generation === runGeneration && state.phase === 'running') {
      pollTimer = setTimeout(() => probeReady(runGeneration), READY_POLL_MS)
    }
  })
}

function waitForClose(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      target.removeListener('close', onClose)
      reject(new Error('ComfyUI 进程树在强制终止后仍未确认退出'))
    }, timeoutMs)
    const onClose = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    target.once('close', onClose)
  })
}

function killTree(target) {
  if (!target || !target.pid) return
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill',
      ['/PID', String(target.pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    )
    killer.unref()
    return
  }
  try {
    process.kill(-target.pid, 'SIGTERM')
  } catch {
    try {
      target.kill('SIGTERM')
    } catch {
      // Already exited.
    }
  }
}

async function stopProcess() {
  const target = child
  if (!target) {
    state.phase = 'stopped'
    state.pid = null
    state.ready = false
    publishState()
    return
  }

  state.phase = 'stopping'
  state.error = null
  publishState()
  clearReadyPoll()
  const closed = waitForClose(target, STOP_TIMEOUT_MS)
  killTree(target)
  await closed
}

async function startProcess(rootValue, portValue) {
  if (child) throw new Error('ComfyUI 已在此扩展中运行')
  const launch = discoverLaunch(rootValue)
  const port = normalizePort(portValue)
  writeConfig({ rootPath: launch.root, port })

  const runGeneration = ++generation
  const args = [
    launch.main,
    '--listen',
    '127.0.0.1',
    '--port',
    String(port),
    ...launch.extraArgs,
  ]
  appendLog(
    'system',
    `启动 ${launch.kind}：${launch.executable} ${args.join(' ')}\n`,
  )
  state = {
    ...state,
    phase: 'starting',
    pid: null,
    ready: false,
    rootPath: launch.root,
    launchKind: launch.kind,
    url: `http://127.0.0.1:${port}`,
    port,
    startedAt: Date.now(),
    stoppedAt: null,
    exitCode: null,
    error: null,
  }
  publishState()

  const spawned = spawn(launch.executable, args, {
    cwd: launch.cwd,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: safeEnvironment(),
  })
  child = spawned

  spawned.stdout.on('data', (chunk) => {
    if (generation === runGeneration) appendLog('stdout', chunk.toString('utf8'))
  })
  spawned.stderr.on('data', (chunk) => {
    if (generation === runGeneration) appendLog('stderr', chunk.toString('utf8'))
  })
  spawned.once('spawn', () => {
    if (generation !== runGeneration || child !== spawned) return
    state.phase = 'running'
    state.pid = spawned.pid || null
    appendLog('system', `ComfyUI 进程已启动，PID ${state.pid || 'unknown'}\n`)
    publishState()
    probeReady(runGeneration)
  })
  spawned.once('error', (error) => {
    if (generation !== runGeneration || child !== spawned) return
    state.phase = 'error'
    state.error = safeError(error)
    appendLog('stderr', `启动失败：${state.error}\n`)
    publishState()
  })
  spawned.once('close', (code, signal) => {
    if (generation !== runGeneration) return
    clearReadyPoll()
    if (child === spawned) child = null
    state.phase =
      state.phase === 'stopping' || code === 0 ? 'stopped' : 'error'
    state.pid = null
    state.ready = false
    state.stoppedAt = Date.now()
    state.exitCode = typeof code === 'number' ? code : null
    if (state.phase === 'error' && !state.error) {
      state.error = `ComfyUI 意外退出（code=${String(code)}, signal=${String(signal)}）`
    }
    appendLog(
      state.phase === 'error' ? 'stderr' : 'system',
      `${state.phase === 'error' ? 'ComfyUI 异常退出' : 'ComfyUI 已停止'}（code=${String(code)}, signal=${String(signal)}）\n`,
    )
    publishState()
  })
}

function serialize(operation) {
  const next = operationTail.then(operation, operation)
  operationTail = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function handleRequest(message) {
  if (
    !message ||
    message.viewId !== VIEW_ID ||
    message.channel !== REQUEST_CHANNEL ||
    !message.payload ||
    typeof message.payload !== 'object' ||
    Array.isArray(message.payload)
  ) {
    return
  }

  const payload = message.payload
  const requestId =
    typeof payload.requestId === 'string' ? payload.requestId.slice(0, 100) : ''
  const action = payload.action
  try {
    if (action === 'snapshot') {
      publishState()
      result(requestId, true, '状态已同步')
      return
    }
    if (action === 'discover') {
      const launch = discoverLaunch(payload.rootPath)
      state.rootPath = launch.root
      state.launchKind = launch.kind
      state.port = normalizePort(payload.port ?? state.port)
      state.url = `http://127.0.0.1:${state.port}`
      state.error = null
      writeConfig({ rootPath: state.rootPath, port: state.port })
      publishState()
      result(requestId, true, `已识别 ${launch.kind}`)
      return
    }
    if (action === 'start') {
      await serialize(() =>
        startProcess(payload.rootPath ?? state.rootPath, payload.port ?? state.port),
      )
      result(requestId, true, 'ComfyUI 启动请求已提交')
      return
    }
    if (action === 'stop') {
      await serialize(() => stopProcess())
      result(requestId, true, 'ComfyUI 已确认停止')
      return
    }
    if (action === 'restart') {
      await serialize(async () => {
        const root = payload.rootPath ?? state.rootPath
        const port = payload.port ?? state.port
        await stopProcess()
        await startProcess(root, port)
      })
      result(requestId, true, 'ComfyUI 重启请求已提交')
      return
    }
    if (action === 'clearLogs') {
      logLines = []
      logChars = 0
      publishState()
      result(requestId, true, '终端日志已清空')
      return
    }
    throw new Error('未知 ComfyUI 操作')
  } catch (error) {
    state.error = safeError(error)
    if (!child && !['discover', 'snapshot', 'clearLogs'].includes(action)) {
      state.phase = 'error'
    }
    appendLog('stderr', `${state.error}\n`)
    publishState()
    result(requestId, false, state.error)
  }
}

exports.activate = async function activate(extensionContext) {
  context = extensionContext
  const config = readConfig()
  state.rootPath = config.rootPath
  state.port = config.port
  state.url = `http://127.0.0.1:${config.port}`
  context.onViewMessage((message) => handleRequest(message))
  appendLog('system', 'ComfyUI Control Host 已就绪。请选择或确认本机 ComfyUI 目录。\n')
}

exports.deactivate = async function deactivate() {
  clearReadyPoll()
  await serialize(() => stopProcess())
  context = null
}