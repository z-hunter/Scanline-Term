/* global process, fetch, AbortSignal, WebSocket, console, setTimeout, clearTimeout, URL, performance */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const port = Number(process.env.STERM_BENCH_CDP_PORT || 9223);
const fixtureUrl = 'http://localhost:5173/texture-stream-benchmark.html';
const warmupMs = Number(option('--warmup-ms', 15000));
const measureMs = Number(option('--measure-ms', 60000));
const pairs = Number(option('--pairs', 2));
const textureFirst = process.argv.includes('--texture-first');
const selectedMode = option('--mode', 'paired');
const output = resolve(option('--out', `output/texture-stream-benchmark/${new Date().toISOString().replaceAll(':', '-')}.json`));
if (![warmupMs, measureMs, pairs].every(Number.isFinite) || warmupMs < 0 || measureMs < 1000 || pairs < 1 || !['paired', 'jpeg', 'texture'].includes(selectedMode)) {
  throw new Error('Expected --mode paired|jpeg|texture, --warmup-ms >= 0, --measure-ms >= 1000, and --pairs >= 1');
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(12000) });
if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
const targets = await response.json();
const target = targets.find((item) => item.type === 'page' && typeof item.url === 'string' && new URL(item.url).href === 'http://localhost:5173/');
if (!target) throw new Error('No Scanline Term host WebView at http://localhost:5173; start the dev app with CDP port 9223');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => {
  ws.addEventListener('open', resolveOpen, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener('close', () => {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error('Scanline Term disconnected from the benchmark CDP session'));
  }
  pending.clear();
});
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve: done, reject, timer } = pending.get(message.id);
  clearTimeout(timer);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else done(message);
});
function send(method, params = {}, timeoutMs = 30000) {
  return new Promise((done, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, { resolve: done, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, timeoutMs = 30000) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.result.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.description || result.result.exceptionDetails.text || 'CDP expression failed');
  return result.result.result.value;
}
let apiCheck = false;
for (let attempt = 0; attempt < 45 && !apiCheck; ++attempt) {
  apiCheck = await evaluate(`typeof window.__scanlineBrowserBenchmark === 'object' && ['open','read','close'].every(k => typeof window.__scanlineBrowserBenchmark[k] === 'function')`);
  if (!apiCheck) await sleep(1000);
}
if (!apiCheck) throw new Error('window.__scanlineBrowserBenchmark open/read/close API is unavailable');

const telemetry = startProcessSampler();
const runs = [];
let failure = null;
async function saveResult() {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    target: { url: target.url, title: target.title, cdpPort: port },
    fixtureUrl,
    warmupMs,
    measureMs,
    pairs,
    selectedMode,
    latencyMeaning: 'App-reported capture timestamp to SVS draw/submission CPU latency; empty if the platform timestamp conversion is unavailable.',
    processSampling: { scope: 'debug app process tree rooted under src-tauri/target/debug', gpuCounter: 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine', cpuPercentScale: '100% means all logical processors combined' },
    runs,
    processSamples: telemetry.samples,
    processSamplingError: telemetry.error || (telemetry.samples.length ? null : 'No app process samples; expected scanline_term.exe under src-tauri/target/debug.'),
    failure
  }, null, 2));
}
try {
  for (let pair = 0; pair < pairs; pair++) {
    const pairedOrder = (pair % 2 !== 0) !== textureFirst ? ['texture', 'jpeg'] : ['jpeg', 'texture'];
    const order = selectedMode === 'paired' ? pairedOrder : [selectedMode];
    let pairGeometry;
    for (const mode of order) {
      await evaluate(`window.__scanlineBrowserBenchmark.close()`);
      await evaluate(`window.__scanlineBrowserBenchmark.open({mode:${JSON.stringify(mode)},url:${JSON.stringify(fixtureUrl)}})`, 120000);
      await sleep(warmupMs);
      const startedAt = new Date().toISOString();
      const start = checkedRead(await evaluate(`window.__scanlineBrowserBenchmark.read()`));
      const geometry = geometryKey(start);
      if (pairGeometry && pairGeometry !== geometry) throw new Error('Capture or output geometry changed between modes');
      pairGeometry = geometry;
      const startTime = performance.now();
      const latencySamplesMs = [];
      const reads = [];
      while (performance.now() - startTime < measureMs) {
        await sleep(Math.min(1000, measureMs - (performance.now() - startTime)));
        const sample = checkedRead(await evaluate(`window.__scanlineBrowserBenchmark.read()`));
        if (geometryKey(sample) !== geometry) throw new Error('Capture or output geometry changed during the measurement');
        reads.push({ at: new Date().toISOString(), ...sample });
        if (Array.isArray(sample?.latencySamplesMs)) latencySamplesMs.push(...sample.latencySamplesMs);
      }
      const end = reads.at(-1) || checkedRead(await evaluate(`window.__scanlineBrowserBenchmark.read()`));
      const elapsedSeconds = (performance.now() - startTime) / 1000;
      const processSamples = telemetry.samples.filter((sample) => sample.time >= Date.parse(startedAt) && sample.time <= Date.parse(new Date().toISOString()));
      runs.push({
        pair: pair + 1,
        mode,
        startedAt,
        elapsedSeconds,
        fixtureUrl,
        warmupMs,
        start,
        end,
        reads,
        effectiveSubmittedFps: delta(end?.submittedFrames, start?.submittedFrames) / elapsedSeconds,
        effectiveDistinctFps: delta(end?.distinctFrames, start?.distinctFrames) / elapsedSeconds,
        latency: summarize(latencySamplesMs),
        latencySamplesMs,
        outputWidth: end?.outputWidth ?? end?.sourceWidth ?? null,
        outputHeight: end?.outputHeight ?? end?.sourceHeight ?? null,
        preset: end?.preset ?? null,
        processMetrics: summarizeProcesses(processSamples),
        processSamples
      });
      console.log(`${mode} pair ${pair + 1}: ${runs.at(-1).effectiveSubmittedFps.toFixed(1)} submitted fps, ${runs.at(-1).effectiveDistinctFps.toFixed(1)} distinct fps`);
      await saveResult();
    }
  }
} catch (error) {
  failure = String(error?.stack || error);
  await saveResult();
  throw error;
} finally {
  await evaluate(`window.__scanlineBrowserBenchmark.close()`).catch(() => {});
  ws.close();
  telemetry.stop();
}

await saveResult();
console.log(`Raw benchmark saved to ${output}`);

function delta(end, start) { return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : 0; }
function checkedRead(value) {
  if (!value || typeof value !== 'object') throw new Error(`Benchmark read() returned no metrics: ${JSON.stringify(value)}`);
  if (value.error) throw new Error(`Browser benchmark failed: ${value.error}`);
  if (!Number.isFinite(value.submittedFrames) || !Number.isFinite(value.distinctFrames)) {
    throw new Error(`Benchmark read() must return numeric submittedFrames and distinctFrames: ${JSON.stringify(value)}`);
  }
  return value;
}
function summarize(values) {
  if (!values.length) return { count: 0, medianMs: null, p95Ms: null };
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, medianMs: null, p95Ms: null };
  return { count: sorted.length, medianMs: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) };
}
function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; }
function summarizeProcesses(samples) {
  const byPid = new Map();
  for (const sample of samples) for (const process of sample.processes || []) {
    if (!byPid.has(process.pid)) byPid.set(process.pid, { pid: process.pid, name: process.name, cpu: [], gpu3d: [], gpuAll: [] });
    const entry = byPid.get(process.pid);
    if (Number.isFinite(process.cpuPercent)) entry.cpu.push(process.cpuPercent);
    if (Number.isFinite(process.gpu3dPercent)) entry.gpu3d.push(process.gpu3dPercent);
    if (Number.isFinite(process.gpuAllEnginesPercent)) entry.gpuAll.push(process.gpuAllEnginesPercent);
  }
  return [...byPid.values()].map(({ pid, name, cpu, gpu3d, gpuAll }) => ({
    pid, name,
    cpuMedianPercent: summarize(cpu).medianMs,
    gpu3dMedianPercent: summarize(gpu3d).medianMs,
    gpuAllEnginesMedianPercent: summarize(gpuAll).medianMs
  }));
}
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

function geometryKey(sample) {
  return [sample.sourceWidth, sample.sourceHeight, sample.outputWidth, sample.outputHeight,
    sample.rasterWidth, sample.rasterHeight, sample.preset].join('/');
}

function startProcessSampler() {
  const samples = [];
  const powershell = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$logical = [Environment]::ProcessorCount
$debugPath = Join-Path (Get-Location).Path 'src-tauri\target\debug'
$lastCpu = @{}
$lastAt = $null
while ($true) {
  $all = Get-CimInstance Win32_Process
  $app = $all | Where-Object { $_.Name -in @('scanline_term.exe', 'scanline-term.exe') -and $_.ExecutablePath -like ($debugPath + '*') } | Select-Object -First 1
  if ($app) {
    $ids = @([int]$app.ProcessId)
    do {
      $oldCount = $ids.Count
      $ids += @($all | Where-Object { $ids -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
      $ids = @($ids | Sort-Object -Unique)
    } while ($ids.Count -gt $oldCount)
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $seconds = if ($lastAt) { [Math]::Max(.1, ($now - $lastAt) / 1000) } else { 1 }
    $lastAt = $now
    $items = @()
    foreach ($p in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) {
      $cpu = [double]$p.CPU
      $pct = $null
      if ($lastCpu.ContainsKey([int]$p.Id)) { $pct = [Math]::Max(0, (($cpu - $lastCpu[[int]$p.Id]) / $seconds / $logical) * 100) }
      $lastCpu[[int]$p.Id] = $cpu
      $items += [pscustomobject]@{ pid = [int]$p.Id; name = $p.ProcessName; cpuPercent = $pct; workingSetBytes = [long]$p.WorkingSet64 }
    }
    $gpu3d = 0.0; $gpuAll = 0.0; $gpuAvailable = $false; $gpuByPid = @{}
    $counter = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
    if ($counter) {
      $gpuAvailable = $true
      foreach ($sample in $counter) {
        if ($sample.Name -match '^pid_([0-9]+)_') {
          $enginePid = [int]$Matches[1]
          if ($ids -contains $enginePid) {
            $value = [double]$sample.UtilizationPercentage
            if (-not $gpuByPid.ContainsKey($enginePid)) { $gpuByPid[$enginePid] = @{ all = 0.0; d3 = 0.0 } }
            $gpuByPid[$enginePid].all += $value; $gpuAll += $value
            if ($sample.Name -match 'engtype_3D') { $gpuByPid[$enginePid].d3 += $value; $gpu3d += $value }
          }
        }
      }
    }
    foreach ($item in $items) {
      $gpu = $gpuByPid[[int]$item.pid]
      $item | Add-Member -NotePropertyName gpu3dPercent -NotePropertyValue $(if ($gpu) { $gpu.d3 } elseif ($gpuAvailable) { 0.0 })
      $item | Add-Member -NotePropertyName gpuAllEnginesPercent -NotePropertyValue $(if ($gpu) { $gpu.all } elseif ($gpuAvailable) { 0.0 })
    }
    [pscustomobject]@{ time = $now; rootPid = [int]$app.ProcessId; logicalProcessors = $logical; processes = $items; gpu3dPercent = $gpu3d; gpuAllEnginesPercent = $gpuAll; gpuCountersAvailable = $gpuAvailable } | ConvertTo-Json -Compress -Depth 5
  }
  Start-Sleep -Seconds 1
}`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershell], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let pendingLine = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pendingLine += chunk;
    const lines = pendingLine.split(/\r?\n/);
    pendingLine = lines.pop() || '';
    for (const line of lines) { try { samples.push(JSON.parse(line)); } catch { /* Ignore PowerShell startup chatter. */ } }
  });
  let error = '';
  child.on('error', (e) => { error += String(e); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { error += chunk; });
  return { samples, get error() { return child.exitCode === null && !error ? '' : error.trim() || `PowerShell exited ${child.exitCode}`; }, stop: () => child.kill() };
}
