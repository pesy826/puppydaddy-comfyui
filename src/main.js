'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')

const VIEW_ID = 'com.puppydaddy.comfyui.console'
const REQUEST_CHANNEL = 'comfyui.request'
const STATE_CHANNEL = 'comfyui.state'
const LOG_CHANNEL = 'comfyui.log'
const RESULT_CHANNEL = 'comfyui.result'

const MAX_LOG_ENTRIES = 1200
const MAX_LOG_BYTES = 256 * 1024
const SNAPSHOT_LOG_BYTES = 2 * 1024
const READY_TIMEOUT_MS = 45_000
const STOP_TIMEOUT_MS = 12_000
const API_TIMEOUT_MS = 20_000
const GENERATION_TIMEOUT_MS = 20 * 60_000
const JOB_LIMIT = 6
const INVENTORY_LIMIT = 20
const WORKFLOW_TEXT_LIMIT = 8 * 1024
const STATE_SNAPSHOT_BYTES = 60 * 1024

let context
let child
let operationTail = Promise.resolve()
let generation = 0
let readyTimer
let logs = []
let logBytes = 0
let inventory = {
  loaded: false,
  checkpoints: [],
  samplers: [],
  schedulers: [],
  loadedAt: null,
  error: null,
}
let jobs = new Map()

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
  generation: {
    workflowMode: 'txt2img',
    checkpoint: '',
    sampler: 'euler',
    scheduler: 'normal',
    width: 1024,
    height: 1024,
    steps: 20,
    cfg: 7,
    seed: -1,
    batchSize: 1,
    positivePrompt: '',
    negativePrompt: '',
    workflowJson: '',
  },
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function clampText(value, max) {
  return String(value == null ? '' : value).slice(0, max)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function snapshotLogs() {
  let bytes = 0
  const selected = []
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const item = logs[index]
    const size = Buffer.byteLength(item.text, 'utf8') + 80
    if (selected.length && bytes + size > SNAPSHOT_LOG_BYTES) break
    selected.unshift(item)
    bytes += size
  }
  return selected
}

function jobSnapshot(job) {
  const parameters = job.parameters || {}
  return {
    promptId: job.promptId,
    status: job.status,
    progress: job.progress,
    currentNode: job.currentNode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    outputs: Array.isArray(job.outputs) ? job.outputs.slice(0, 8) : [],
    parameters: {
      workflowMode: parameters.workflowMode,
      checkpoint: parameters.checkpoint,
      sampler: parameters.sampler,
      scheduler: parameters.scheduler,
      width: parameters.width,
      height: parameters.height,
      steps: parameters.steps,
      cfg: parameters.cfg,
      seed: parameters.seed,
      batchSize: parameters.batchSize,
      positivePrompt: clampText(parameters.positivePrompt, 160),
      negativePrompt: clampText(parameters.negativePrompt, 160),
    },
  }
}

function cloneState() {
  const snapshot = {
    ...cloneJson(state),
    inventory: cloneJson(inventory),
    jobs: [...jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, JOB_LIMIT)
      .map(jobSnapshot),
    logs: snapshotLogs(),
  }
  while (
    snapshot.jobs.length > 1 &&
    Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > STATE_SNAPSHOT_BYTES
  ) {
    snapshot.jobs.pop()
  }
  return snapshot
}

function post(channel, payload) {
  if (!context) return
  context.postViewMessage(VIEW_ID, channel, payload)
}

function publishState() {
  post(STATE_CHANNEL, cloneState())
}

function result(requestId, ok, message, data) {
  post(RESULT_CHANNEL, {
    requestId: typeof requestId === 'string' ? requestId : '',
    ok: !!ok,
    message: clampText(message, 2000),
    ...(data === undefined ? {} : { data }),
  })
}

function appendLog(stream, text) {
  const chunks = String(text).replace(/\r\n/g, '\n').split(/(?<=\n)/)
  for (const chunk of chunks) {
    if (!chunk) continue
    const item = {
      id: `log_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      ts: Date.now(),
      stream,
      text: clampText(chunk, 12 * 1024),
    }
    logs.push(item)
    logBytes += Buffer.byteLength(item.text, 'utf8')
    post(LOG_CHANNEL, item)
  }
  while (logs.length > MAX_LOG_ENTRIES || logBytes > MAX_LOG_BYTES) {
    const removed = logs.shift()
    if (!removed) break
    logBytes -= Buffer.byteLength(removed.text, 'utf8')
  }
}

function configPath() {
  if (!context) throw new Error('扩展上下文尚未就绪')
  return path.join(context.storagePath, 'config.json')
}

function normalizePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('端口必须是 1024-65535 的整数')
  }
  return port
}

function normalizeRoot(value) {
  const root = path.resolve(String(value || '').trim())
  if (!root || !path.isAbsolute(root)) throw new Error('请选择本机 ComfyUI 目录')
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('ComfyUI 根目录必须是普通目录，不能是符号链接')
  }
  return root
}

function boundedNumber(value, fallback, min, max, integer) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const clamped = Math.min(max, Math.max(min, number))
  return integer ? Math.round(clamped) : clamped
}

function normalizeGeneration(input, previous = state.generation) {
  const source = isPlainObject(input) ? input : {}
  const workflowMode =
    source.workflowMode === undefined
      ? previous.workflowMode === 'api'
        ? 'api'
        : 'txt2img'
      : source.workflowMode === 'api'
        ? 'api'
        : 'txt2img'
  const workflowJson = clampText(
    source.workflowJson ?? previous.workflowJson ?? '',
    WORKFLOW_TEXT_LIMIT,
  )
  return {
    workflowMode,
    checkpoint: clampText(source.checkpoint ?? previous.checkpoint ?? '', 500),
    sampler: clampText(source.sampler ?? previous.sampler ?? 'euler', 120),
    scheduler: clampText(source.scheduler ?? previous.scheduler ?? 'normal', 120),
    width: boundedNumber(source.width, previous.width || 1024, 64, 4096, true),
    height: boundedNumber(source.height, previous.height || 1024, 64, 4096, true),
    steps: boundedNumber(source.steps, previous.steps || 20, 1, 150, true),
    cfg: boundedNumber(source.cfg, previous.cfg || 7, 0.1, 30, false),
    seed: boundedNumber(source.seed, previous.seed ?? -1, -1, Number.MAX_SAFE_INTEGER, true),
    batchSize: boundedNumber(source.batchSize, previous.batchSize || 1, 1, 8, true),
    positivePrompt: clampText(
      source.positivePrompt ?? previous.positivePrompt ?? '',
      2_000,
    ),
    negativePrompt: clampText(
      source.negativePrompt ?? previous.negativePrompt ?? '',
      2_000,
    ),
    workflowJson,
  }
}

function readConfig() {
  const fallback = {
    rootPath: '',
    port: 8188,
    generation: normalizeGeneration({}),
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    if (!isPlainObject(parsed)) return fallback
    return {
      rootPath:
        typeof parsed.rootPath === 'string' ? parsed.rootPath.slice(0, 4000) : '',
      port:
        Number.isInteger(parsed.port) &&
        parsed.port >= 1024 &&
        parsed.port <= 65535
          ? parsed.port
          : 8188,
      generation: normalizeGeneration(parsed.generation),
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      appendLog('system', `读取配置失败，使用默认值：${safeError(error)}\n`)
    }
    return fallback
  }
}

function writeConfig(config) {
  const target = configPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(config, null, 2)}\n`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, body, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(temp, target)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {}
    throw error
  }
}

function persistSettings(rootPath = state.rootPath, port = state.port) {
  writeConfig({
    rootPath,
    port,
    generation: state.generation,
  })
}

function ordinaryFile(file) {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function resolveLaunch(rootValue) {
  const selected = normalizeRoot(rootValue)
  const roots = [selected]
  const portableChild = path.join(selected, 'ComfyUI_windows_portable')
  try {
    const childStat = fs.lstatSync(portableChild)
    if (childStat.isDirectory() && !childStat.isSymbolicLink()) roots.push(portableChild)
  } catch {}

  for (const root of roots) {
    const comfyRoot = path.join(root, 'ComfyUI')
    const mainFile = path.join(comfyRoot, 'main.py')
    const portablePython = path.join(root, 'python_embeded', 'python.exe')
    if (ordinaryFile(portablePython) && ordinaryFile(mainFile)) {
      return {
        selected,
        resolvedRoot: root,
        command: portablePython,
        mainFile,
        cwd: comfyRoot,
        launchKind: 'windows-portable',
        extraArgs: ['--windows-standalone-build'],
      }
    }

    const directMain = path.join(root, 'main.py')
    const candidates =
      process.platform === 'win32'
        ? [
            ['.venv', 'Scripts', 'python.exe'],
            ['venv', 'Scripts', 'python.exe'],
            ['python.exe'],
          ]
        : [
            ['.venv', 'bin', 'python'],
            ['venv', 'bin', 'python'],
            ['python'],
          ]
    for (const parts of candidates) {
      const executable = path.join(root, ...parts)
      if (ordinaryFile(executable) && ordinaryFile(directMain)) {
        return {
          selected,
          resolvedRoot: root,
          command: executable,
          mainFile: directMain,
          cwd: root,
          launchKind: parts[0] === 'python.exe' || parts[0] === 'python'
            ? 'bundled-python'
            : `virtualenv:${parts[0]}`,
          extraArgs: [],
        }
      }
    }
  }
  throw new Error(
    '目录中未找到受支持的 ComfyUI 布局。请选择 portable 根目录（含 python_embeded 与 ComfyUI/main.py）或含 main.py 和固定 Python/venv 的目录。',
  )
}

function safeEnvironment() {
  const allowed = [
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
    'CUDA_HOME',
  ]
  const env = {}
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function clearReadyPoll() {
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = undefined
}

function apiBase() {
  return `http://127.0.0.1:${state.port}`
}

function apiUrl(relative) {
  return new URL(relative, `${apiBase()}/`).toString()
}

async function fetchWithTimeout(relative, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const externalSignal = options.signal
  const onAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(apiUrl(relative), {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    })
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort)
  }
}

async function requestJson(relative, options = {}, timeoutMs) {
  const response = await fetchWithTimeout(relative, options, timeoutMs)
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`ComfyUI 返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === 'object'
        ? JSON.stringify(parsed).slice(0, 1500)
        : text.slice(0, 1500)
    throw new Error(`ComfyUI API HTTP ${response.status}：${detail}`)
  }
  return parsed
}

async function probeReady(runGeneration) {
  if (runGeneration !== generation || !child) return
  try {
    await requestJson('system_stats', {}, 1800)
    if (runGeneration !== generation || !child) return
    state.phase = 'running'
    state.ready = true
    state.error = null
    state.url = apiBase()
    appendLog('system', `ComfyUI API 已就绪：${state.url}\n`)
    publishState()
    void refreshInventory().catch((error) => {
      appendLog('system', `读取 ComfyUI 模型清单失败：${safeError(error)}\n`)
    })
    return
  } catch {}

  if (
    runGeneration !== generation ||
    !child ||
    Date.now() - (state.startedAt || 0) > READY_TIMEOUT_MS
  ) {
    if (child && runGeneration === generation) {
      state.error = 'ComfyUI 进程已启动，但 API 在等待时限内未就绪'
      state.phase = 'error'
      publishState()
    }
    return
  }
  readyTimer = setTimeout(() => {
    void probeReady(runGeneration)
  }, 700)
}

function waitForClose(target, timeoutMs) {
  if (!target || target.exitCode !== null || target.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let timer
    const onClose = () => {
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      target.removeListener('close', onClose)
      reject(new Error('等待 ComfyUI 进程退出超时'))
    }, timeoutMs)
    target.once('close', onClose)
  })
}

function killTree(target) {
  if (!target || !target.pid) return
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill',
      ['/PID', String(target.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', shell: false },
    )
    killer.unref()
    return
  }
  try {
    process.kill(-target.pid, 'SIGKILL')
  } catch {
    try {
      target.kill('SIGKILL')
    } catch {}
  }
}

async function stopProcess() {
  generation += 1
  clearReadyPoll()
  const target = child
  if (!target) {
    state.phase = 'stopped'
    state.pid = null
    state.ready = false
    state.stoppedAt = Date.now()
    publishState()
    return
  }
  state.phase = 'stopping'
  state.ready = false
  publishState()
  killTree(target)
  await waitForClose(target, STOP_TIMEOUT_MS)
  if (child === target) child = undefined
  state.phase = 'stopped'
  state.pid = null
  state.ready = false
  state.stoppedAt = Date.now()
  publishState()
}

async function startProcess(rootValue, portValue) {
  if (child) await stopProcess()
  const launch = resolveLaunch(rootValue)
  const port = normalizePort(portValue)
  const runGeneration = ++generation

  state = {
    ...state,
    phase: 'starting',
    pid: null,
    ready: false,
    rootPath: launch.selected,
    launchKind: launch.launchKind,
    url: `http://127.0.0.1:${port}`,
    port,
    startedAt: Date.now(),
    stoppedAt: null,
    exitCode: null,
    error: null,
  }
  persistSettings(state.rootPath, port)
  inventory = {
    loaded: false,
    checkpoints: [],
    samplers: [],
    schedulers: [],
    loadedAt: null,
    error: null,
  }
  publishState()

  const args = [
    launch.mainFile,
    ...launch.extraArgs,
    '--listen',
    '127.0.0.1',
    '--port',
    String(port),
  ]
  appendLog(
    'system',
    `启动 ${launch.launchKind}：${launch.command} ${args.join(' ')}\n`,
  )
  const spawned = spawn(launch.command, args, {
    cwd: launch.cwd,
    env: safeEnvironment(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = spawned
  state.pid = spawned.pid || null
  publishState()

  spawned.stdout.on('data', (chunk) => appendLog('stdout', chunk.toString('utf8')))
  spawned.stderr.on('data', (chunk) => appendLog('stderr', chunk.toString('utf8')))
  spawned.once('error', (error) => {
    if (runGeneration !== generation) return
    state.phase = 'error'
    state.error = safeError(error)
    appendLog('system', `ComfyUI 启动错误：${state.error}\n`)
    publishState()
  })
  spawned.once('close', (code) => {
    if (child === spawned) child = undefined
    if (runGeneration !== generation) return
    clearReadyPoll()
    state.phase = 'stopped'
    state.pid = null
    state.ready = false
    state.exitCode = typeof code === 'number' ? code : null
    state.stoppedAt = Date.now()
    appendLog('system', `ComfyUI 进程已退出，代码 ${String(code)}\n`)
    publishState()
  })
  void probeReady(runGeneration)
}

function serialize(operation) {
  const next = operationTail.then(operation, operation)
  operationTail = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function enumFromObjectInfo(objectInfo, nodeType, inputName) {
  const node = objectInfo && objectInfo[nodeType]
  const required = node && node.input && node.input.required
  const optional = node && node.input && node.input.optional
  const spec = (required && required[inputName]) || (optional && optional[inputName])
  if (!Array.isArray(spec) || !Array.isArray(spec[0])) return []
  return spec[0]
    .filter((item) => typeof item === 'string')
    .map((item) => item.slice(0, 180))
    .slice(0, INVENTORY_LIMIT)
}

async function refreshInventory(signal) {
  if (!state.ready) throw new Error('ComfyUI API 尚未就绪')
  try {
    const objectInfo = await requestJson('object_info', { signal }, 45_000)
    let checkpoints = enumFromObjectInfo(
      objectInfo,
      'CheckpointLoaderSimple',
      'ckpt_name',
    )
    const samplers = enumFromObjectInfo(objectInfo, 'KSampler', 'sampler_name')
    const schedulers = enumFromObjectInfo(objectInfo, 'KSampler', 'scheduler')
    if (!checkpoints.length) {
      try {
        const models = await requestJson('models/checkpoints', { signal })
        if (Array.isArray(models)) {
          checkpoints = models
            .filter((item) => typeof item === 'string')
            .map((item) => item.slice(0, 500))
            .slice(0, INVENTORY_LIMIT)
        }
      } catch {}
    }
    inventory = {
      loaded: true,
      checkpoints,
      samplers,
      schedulers,
      loadedAt: Date.now(),
      error: null,
    }
    if (!state.generation.checkpoint && checkpoints[0]) {
      state.generation.checkpoint = checkpoints[0]
    }
    if (
      samplers.length &&
      !samplers.includes(state.generation.sampler)
    ) {
      state.generation.sampler = samplers[0]
    }
    if (
      schedulers.length &&
      !schedulers.includes(state.generation.scheduler)
    ) {
      state.generation.scheduler = schedulers[0]
    }
    persistSettings()
    publishState()
    return cloneJson(inventory)
  } catch (error) {
    inventory = {
      ...inventory,
      loaded: false,
      error: safeError(error).slice(0, 1000),
    }
    publishState()
    throw error
  }
}

function requireEnum(value, options, label) {
  if (!options.length) return value
  if (!options.includes(value)) throw new Error(`${label} 不在当前 ComfyUI 可用清单中`)
  return value
}

function randomSeed() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}

function buildTxt2ImgWorkflow(parameters) {
  const checkpoint = requireEnum(
    parameters.checkpoint,
    inventory.checkpoints,
    'Checkpoint',
  )
  if (!checkpoint) throw new Error('请先选择 Checkpoint 模型')
  const sampler = requireEnum(
    parameters.sampler,
    inventory.samplers,
    '采样器',
  )
  const scheduler = requireEnum(
    parameters.scheduler,
    inventory.schedulers,
    '调度器',
  )
  const seed = parameters.seed < 0 ? randomSeed() : parameters.seed
  return {
    workflow: {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: checkpoint },
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: parameters.positivePrompt, clip: ['1', 1] },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: parameters.negativePrompt, clip: ['1', 1] },
      },
      '4': {
        class_type: 'EmptyLatentImage',
        inputs: {
          width: parameters.width,
          height: parameters.height,
          batch_size: parameters.batchSize,
        },
      },
      '5': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: parameters.steps,
          cfg: parameters.cfg,
          sampler_name: sampler,
          scheduler,
          denoise: 1,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
        },
      },
      '6': {
        class_type: 'VAEDecode',
        inputs: { samples: ['5', 0], vae: ['1', 2] },
      },
      '7': {
        class_type: 'SaveImage',
        inputs: {
          filename_prefix: 'puppydaddy/ComfyUI',
          images: ['6', 0],
        },
      },
    },
    parameters: { ...parameters, seed },
  }
}

function parseApiWorkflow(workflowJson) {
  const text = String(workflowJson || '')
  if (!text.trim()) throw new Error('API 工作流 JSON 不能为空')
  if (Buffer.byteLength(text, 'utf8') > WORKFLOW_TEXT_LIMIT) {
    throw new Error('API 工作流 JSON 超过 8KiB 上限')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`API 工作流 JSON 解析失败：${safeError(error)}`)
  }
  if (!isPlainObject(parsed)) throw new Error('API 工作流必须是节点 ID 到节点对象的映射')
  const entries = Object.entries(parsed)
  if (!entries.length || entries.length > 500) {
    throw new Error('API 工作流节点数必须在 1-500 之间')
  }
  for (const [nodeId, node] of entries) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(nodeId) ||
      !isPlainObject(node) ||
      typeof node.class_type !== 'string' ||
      !node.class_type ||
      !isPlainObject(node.inputs)
    ) {
      throw new Error(`API 工作流节点 ${nodeId} 格式无效`)
    }
  }
  return parsed
}

function workflowForParameters(parameters) {
  if (parameters.workflowMode === 'api') {
    return {
      workflow: parseApiWorkflow(parameters.workflowJson),
      parameters,
    }
  }
  return buildTxt2ImgWorkflow(parameters)
}

function outputMime(filename) {
  const extension = path.extname(String(filename || '')).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.bmp') return 'image/bmp'
  return undefined
}

function extractOutputs(historyEntry) {
  const outputs = []
  const nodes = historyEntry && historyEntry.outputs
  if (!isPlainObject(nodes)) return outputs
  for (const node of Object.values(nodes)) {
    if (!isPlainObject(node) || !Array.isArray(node.images)) continue
    for (const image of node.images) {
      if (
        !isPlainObject(image) ||
        typeof image.filename !== 'string' ||
        !image.filename
      ) {
        continue
      }
      const params = new URLSearchParams({
        filename: image.filename,
        type: typeof image.type === 'string' ? image.type : 'output',
        subfolder:
          typeof image.subfolder === 'string' ? image.subfolder : '',
      })
      outputs.push({
        filename: image.filename.slice(0, 180),
        subfolder:
          typeof image.subfolder === 'string'
            ? image.subfolder.slice(0, 180)
            : '',
        type: typeof image.type === 'string' ? image.type.slice(0, 30) : 'output',
        mimeType: outputMime(image.filename),
        url: `${apiBase()}/view?${params.toString()}`,
      })
    }
  }
  return outputs.slice(0, 8)
}

function setJob(promptId, patch) {
  const previous = jobs.get(promptId)
  if (!previous) return
  jobs.set(promptId, {
    ...previous,
    ...patch,
    updatedAt: Date.now(),
  })
  while (jobs.size > JOB_LIMIT) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!oldest) break
    jobs.delete(oldest.promptId)
  }
  publishState()
}

function queuePromptIds(queue, name) {
  const list = queue && queue[name]
  if (!Array.isArray(list)) return []
  return list
    .map((item) =>
      Array.isArray(item) && typeof item[1] === 'string'
        ? item[1].slice(0, 200)
        : '',
    )
    .filter(Boolean)
    .slice(0, 20)
}

function queueSnapshot(queue) {
  return {
    runningPromptIds: queuePromptIds(queue, 'queue_running'),
    pendingPromptIds: queuePromptIds(queue, 'queue_pending'),
  }
}

function queueContains(queue, name, promptId) {
  return queuePromptIds(queue, name).includes(promptId)
}

function historySnapshot(promptId, historyEntry) {
  if (!isPlainObject(historyEntry)) return null
  const status = isPlainObject(historyEntry.status) ? historyEntry.status : {}
  const messages = Array.isArray(status.messages)
    ? clampText(JSON.stringify(status.messages), 2000)
    : null
  return {
    promptId,
    status:
      typeof status.status_str === 'string'
        ? status.status_str.slice(0, 100)
        : null,
    completed: status.completed === true,
    messages,
    outputs: extractOutputs(historyEntry),
  }
}

function monitorWebSocket(promptId, clientId, signal) {
  if (typeof WebSocket !== 'function') return { close() {} }
  let socket
  try {
    socket = new WebSocket(
      `ws://127.0.0.1:${state.port}/ws?clientId=${encodeURIComponent(clientId)}`,
    )
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data))
        const data = message && message.data
        if (!data || (data.prompt_id && data.prompt_id !== promptId)) return
        if (message.type === 'progress') {
          const value = Number(data.value)
          const max = Number(data.max)
          setJob(promptId, {
            status: 'running',
            progress:
              Number.isFinite(value) && Number.isFinite(max) && max > 0
                ? Math.max(0, Math.min(1, value / max))
                : 0,
            currentNode:
              typeof data.node === 'string' ? data.node.slice(0, 100) : null,
          })
        } else if (message.type === 'executing') {
          setJob(promptId, {
            status: data.node == null ? 'finalizing' : 'running',
            currentNode:
              typeof data.node === 'string' ? data.node.slice(0, 100) : null,
          })
        } else if (message.type === 'execution_error') {
          setJob(promptId, {
            status: 'error',
            error: clampText(data.exception_message || 'ComfyUI 执行错误', 2000),
          })
        }
      } catch {}
    })
  } catch {
    return { close() {} }
  }
  const onAbort = () => {
    try {
      socket.close()
    } catch {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return {
    close() {
      signal.removeEventListener('abort', onAbort)
      try {
        socket.close()
      } catch {}
    },
  }
}

async function waitForJob(promptId, clientId, signal) {
  const startedAt = Date.now()
  const ws = monitorWebSocket(promptId, clientId, signal)
  try {
    while (Date.now() - startedAt < GENERATION_TIMEOUT_MS) {
      if (signal.aborted) {
        throw Object.assign(new Error('生成任务已取消'), { name: 'AbortError' })
      }
      const history = await requestJson(
        `history/${encodeURIComponent(promptId)}`,
        { signal },
        30_000,
      )
      const entry = history && history[promptId]
      if (entry) {
        const outputs = extractOutputs(entry)
        const status = entry.status
        if (status && status.status_str === 'error') {
          const messages = Array.isArray(status.messages)
            ? JSON.stringify(status.messages).slice(0, 2000)
            : 'ComfyUI 执行失败'
          setJob(promptId, { status: 'error', error: messages })
          throw new Error(messages)
        }
        setJob(promptId, {
          status: 'completed',
          progress: 1,
          currentNode: null,
          outputs,
          error: null,
        })
        return outputs
      }

      try {
        const queue = await requestJson('queue', { signal })
        const running = queueContains(queue, 'queue_running', promptId)
        const pending = queueContains(queue, 'queue_pending', promptId)
        setJob(promptId, {
          status: running ? 'running' : pending ? 'queued' : 'finalizing',
        })
      } catch {}
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('生成任务已取消'), { name: 'AbortError' }))
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, 650)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    throw new Error('等待 ComfyUI 生成结果超时，结果可能仍在后台生成')
  } finally {
    ws.close()
  }
}

async function submitGeneration(input, signal, waitForResult) {
  if (!state.ready) throw new Error('ComfyUI API 尚未就绪')
  if (!inventory.loaded) await refreshInventory(signal)
  const parameters = normalizeGeneration(input, state.generation)
  const prepared = workflowForParameters(parameters)
  state.generation = prepared.parameters
  persistSettings()
  publishState()

  const clientId = `puppydaddy_${randomUUID()}`
  const response = await requestJson(
    'prompt',
    {
      method: 'POST',
      signal,
      body: JSON.stringify({
        prompt: prepared.workflow,
        client_id: clientId,
      }),
    },
    45_000,
  )
  const promptId =
    response && typeof response.prompt_id === 'string'
      ? response.prompt_id
      : ''
  if (!promptId) {
    throw new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(response).slice(0, 1000)}`)
  }
  jobs.set(promptId, {
    promptId,
    clientId,
    status: 'queued',
    progress: 0,
    currentNode: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
    outputs: [],
    parameters: prepared.parameters,
  })
  publishState()

  if (!waitForResult) {
    const controller = new AbortController()
    jobs.get(promptId).controller = controller
    void waitForJob(promptId, clientId, controller.signal).catch((error) => {
      const current = jobs.get(promptId)
      if (!current || current.status === 'cancelled') return
      setJob(promptId, {
        status: 'error',
        error: safeError(error).slice(0, 2000),
      })
    })
    return { promptId, outputs: [] }
  }
  const outputs = await waitForJob(promptId, clientId, signal)
  return { promptId, outputs }
}

async function cancelJob(promptId, signal) {
  if (!state.ready) throw new Error('ComfyUI API 尚未就绪')
  const id = String(promptId || '').trim()
  const target = id ? jobs.get(id) : [...jobs.values()].find((job) =>
    ['queued', 'running', 'finalizing'].includes(job.status),
  )
  if (!target) throw new Error('找不到可取消的生成任务')
  target.controller?.abort()
  try {
    await requestJson(
      'queue',
      {
        method: 'POST',
        signal,
        body: JSON.stringify({ delete: [target.promptId] }),
      },
      10_000,
    )
  } catch {}
  try {
    await requestJson(
      'interrupt',
      { method: 'POST', signal, body: JSON.stringify({}) },
      10_000,
    )
  } catch {}
  setJob(target.promptId, {
    status: 'cancelled',
    currentNode: null,
    error: null,
  })
  return target.promptId
}

async function jobStatus(promptId, signal) {
  const id = String(promptId || '').trim().slice(0, 200)
  const runtime = {
    phase: state.phase,
    ready: state.ready,
    url: state.url,
  }
  if (!id) {
    try {
      const queue = await requestJson('queue', { signal })
      return {
        runtime,
        queue: queueSnapshot(queue),
        jobs: [...jobs.values()].slice(0, JOB_LIMIT).map(jobSnapshot),
      }
    } catch {
      return {
        runtime,
        jobs: [...jobs.values()].slice(0, JOB_LIMIT).map(jobSnapshot),
      }
    }
  }
  const local = jobs.get(id)
  const history = state.ready
    ? await requestJson(`history/${encodeURIComponent(id)}`, { signal }).catch(
        () => null,
      )
    : null
  return {
    runtime,
    job: local ? jobSnapshot(local) : null,
    history: historySnapshot(id, history && history[id]),
  }
}

async function handleRequest(message) {
  if (!message || message.channel !== REQUEST_CHANNEL) return
  const payload = isPlainObject(message.payload) ? message.payload : {}
  const requestId =
    typeof payload.requestId === 'string' ? payload.requestId.slice(0, 160) : ''
  const action = typeof payload.action === 'string' ? payload.action : ''
  try {
    if (action === 'snapshot') {
      publishState()
      result(requestId, true, '状态已同步')
      return
    }
    if (action === 'start') {
      await serialize(() => startProcess(payload.rootPath, payload.port))
      result(requestId, true, 'ComfyUI 启动请求已提交')
      return
    }
    if (action === 'stop') {
      await serialize(() => stopProcess())
      result(requestId, true, 'ComfyUI 已停止')
      return
    }
    if (action === 'restart') {
      await serialize(async () => {
        await stopProcess()
        await startProcess(payload.rootPath || state.rootPath, payload.port || state.port)
      })
      result(requestId, true, 'ComfyUI 已重启')
      return
    }
    if (action === 'clearLogs') {
      logs = []
      logBytes = 0
      publishState()
      result(requestId, true, '日志已清空')
      return
    }
    if (action === 'saveGeneration') {
      state.generation = normalizeGeneration(payload.parameters, state.generation)
      persistSettings()
      publishState()
      result(requestId, true, '生成参数已保存')
      return
    }
    if (action === 'refreshInventory') {
      const value = await refreshInventory()
      result(requestId, true, '模型与采样器清单已刷新', value)
      return
    }
    if (action === 'validateWorkflow') {
      const parameters = normalizeGeneration(payload.parameters, state.generation)
      const prepared = workflowForParameters(parameters)
      result(requestId, true, '工作流结构校验通过', {
        nodes: Object.keys(prepared.workflow).length,
      })
      return
    }
    if (action === 'generate') {
      const submitted = await submitGeneration(
        payload.parameters,
        new AbortController().signal,
        false,
      )
      result(requestId, true, '生成任务已进入 ComfyUI 队列', submitted)
      return
    }
    if (action === 'cancel') {
      const promptId = await cancelJob(payload.promptId)
      result(requestId, true, '已请求取消生成任务', { promptId })
      return
    }
    if (action === 'jobStatus') {
      const status = await jobStatus(payload.promptId)
      result(requestId, true, '生成状态已刷新', status)
      publishState()
      return
    }
    throw new Error(`未知操作：${action}`)
  } catch (error) {
    const messageText = safeError(error)
    appendLog('system', `${action || 'request'} 失败：${messageText}\n`)
    result(requestId, false, messageText)
  }
}

async function agentInventory(_args, toolContext) {
  const value = await refreshInventory(toolContext.signal)
  return {
    ok: true,
    text: JSON.stringify(
      {
        runtime: {
          phase: state.phase,
          ready: state.ready,
          url: state.url,
        },
        workflows: ['txt2img', 'api'],
        ...value,
        defaults: state.generation,
      },
      null,
      2,
    ),
  }
}

async function agentGenerate(args, toolContext) {
  const input = {
    workflowMode: args.workflow_mode,
    checkpoint: args.checkpoint,
    sampler: args.sampler,
    scheduler: args.scheduler,
    width: args.width,
    height: args.height,
    steps: args.steps,
    cfg: args.cfg,
    seed: args.seed,
    batchSize: args.batch_size,
    positivePrompt: args.prompt,
    negativePrompt: args.negative_prompt,
    workflowJson: args.workflow_json,
  }
  const submitted = await submitGeneration(input, toolContext.signal, true)
  const images = submitted.outputs.map((output) => ({
    source: output.url,
    ...(output.mimeType ? { mimeType: output.mimeType } : {}),
    displayName: output.filename,
  }))
  return {
    ok: true,
    text: JSON.stringify(
      {
        promptId: submitted.promptId,
        outputCount: images.length,
        parameters: jobs.get(submitted.promptId)?.parameters,
      },
      null,
      2,
    ),
    images,
  }
}

async function agentStatus(args, toolContext) {
  return {
    ok: true,
    text: JSON.stringify(
      await jobStatus(args.prompt_id, toolContext.signal),
      null,
      2,
    ),
  }
}

async function agentCancel(args, toolContext) {
  const promptId = await cancelJob(args.prompt_id, toolContext.signal)
  return {
    ok: true,
    text: `已请求取消 ComfyUI 任务：${promptId}`,
  }
}

exports.activate = async function activate(extensionContext) {
  context = extensionContext
  const config = readConfig()
  state.rootPath = config.rootPath
  state.port = config.port
  state.url = `http://127.0.0.1:${config.port}`
  state.generation = config.generation
  context.onViewMessage((message) => handleRequest(message))
  context.registerAgentTool('inventory', agentInventory)
  context.registerAgentTool('generate', agentGenerate)
  context.registerAgentTool('status', agentStatus)
  context.registerAgentTool('cancel', agentCancel)
  appendLog(
    'system',
    'ComfyUI Agent Host 已就绪。PD 对话与扩展工作台共享模型、采样器、工作流、队列和输出状态。\n',
  )
}

exports.deactivate = async function deactivate() {
  clearReadyPoll()
  for (const job of jobs.values()) job.controller?.abort()
  await serialize(() => stopProcess())
  context = undefined
}