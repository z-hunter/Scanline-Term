/* global process, fetch, AbortSignal, WebSocket, URL, console, setTimeout, clearTimeout */

const port = Number(process.env.STERM_PROBE_CDP_PORT || 9223);
const action = process.argv[2] || "state";
const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(12000) });
if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
const targets = await response.json();
const target = targets.find((item) => item.type === "page" && /localhost:5173/.test(item.url));
if (!target) throw new Error("No Scanline Term dev WebView2 page at localhost:5173");
if (new URL(target.url).origin !== "http://localhost:5173") throw new Error(`Refusing non-dev origin: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 10000);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});

const expressions = {
  storageSnapshot: `(()=>{if(location.origin!=='http://localhost:5173')throw Error('refusing storage access outside localhost:5173');const key='scanline-term.settings.v1';return {origin:location.origin,key,raw:localStorage.getItem(key)}})()`,
  enableDevMcp: `(()=>{if(location.origin!=='http://localhost:5173')throw Error('refusing storage write outside localhost:5173');const key='scanline-term.settings.v1';const raw=localStorage.getItem(key);if(raw===null)throw Error('settings key is absent; refusing to invent settings');const settings=JSON.parse(raw);if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('settings value is not an object');const before=!!settings.mcpEnabled;settings.mcpEnabled=true;localStorage.setItem(key,JSON.stringify(settings));return {origin:location.origin,key,before,after:settings.mcpEnabled,rawBefore:raw}})()`,
  restoreDevMcp: `(()=>{if(location.origin!=='http://localhost:5173')throw Error('refusing storage restore outside localhost:5173');const key='scanline-term.settings.v1';const raw=JSON.parse(process.argv[3]);if(raw===null)localStorage.removeItem(key);else if(typeof raw==='string')localStorage.setItem(key,raw);else throw Error('restore payload must be a raw string or null');return {origin:location.origin,key,restored:localStorage.getItem(key)===raw,raw:localStorage.getItem(key)}})()`,
  state: `({title:document.title,href:location.href,readyState:document.readyState,active:document.activeElement?.outerHTML?.slice(0,300),terminalFocused:!!document.activeElement?.matches('canvas.output-canvas[tabindex="0"]'),canvas:!!document.querySelector('canvas.output-canvas[tabindex="0"]'),pageFocused:document.hasFocus(),transportProbeListener:typeof window.__transportProbeListener==='function',windowLogCount:window.__transportProbeEvents?.length??0})`,
  startupDiagnostics: `(()=>({href:location.href,title:document.title,readyState:document.readyState,bodyText:document.body?.innerText?.slice(0,4000)||'',errors:window.__probeStartupErrors||[],probe:window.__scanlineAutomationProbe?{enabled:window.__scanlineAutomationProbe.enabled,status:window.__scanlineAutomationProbe.status,context:window.__scanlineAutomationProbe.context}:null,mcpSettings:(()=>{try{return JSON.parse(localStorage.getItem('scanline-term.settings.v1')||'null')?.mcpEnabled??null}catch{return 'invalid'}})()}))()`,
  cycleMcpSettingsUi: `(async()=>{if(location.origin!=='http://localhost:5173')throw Error('refusing UI settings change outside dev origin');const button=document.querySelector('button[aria-label="Toggle settings"]');if(!button)throw Error('exact Toggle settings button is absent');if(button.getAttribute('aria-pressed')!=='true')button.click();const getToggle=()=>{const label=[...document.querySelectorAll('label.svs-switch')].find(item=>item.querySelector('.svs-switch-label')?.textContent?.trim()==='Enable MCP terminal mode');return label?.querySelector('input[type="checkbox"][role="switch"]')||null};const toggleDeadline=performance.now()+5000;let input=null;while(!input&&performance.now()<toggleDeadline){input=getToggle();await new Promise(requestAnimationFrame)}if(!input)throw Error('exact Enable MCP terminal mode switch did not appear');const states=[];for(const desired of [false,true]){input=getToggle();if(!input)throw Error('MCP switch disappeared during the UI lifecycle');if(input.checked!==desired)input.click();const until=performance.now()+3000;while(performance.now()<until){await new Promise(requestAnimationFrame);input=getToggle();let saved=null;try{saved=JSON.parse(localStorage.getItem('scanline-term.settings.v1')||'null')?.mcpEnabled??null}catch{}if(input?.checked===desired&&saved===desired)break}if(input?.checked!==desired)throw Error('MCP settings switch did not reach '+desired);let saved=null;try{saved=JSON.parse(localStorage.getItem('scanline-term.settings.v1')||'null')?.mcpEnabled??null}catch{}if(saved!==desired)throw Error('MCP settings storage did not reach '+desired);states.push({checked:input.checked,stored:saved})}const closeButton=document.querySelector('button[aria-label="Toggle settings"]');if(closeButton?.getAttribute('aria-pressed')==='true')closeButton.click();return {origin:location.origin,states,settingsOpen:document.querySelector('button[aria-label="Toggle settings"]')?.getAttribute('aria-pressed')}})()`,
  focusTerminal: `(()=>{const el=document.querySelector('canvas.output-canvas[tabindex="0"]');if(el)el.focus();return {terminalFocused:!!el&&document.activeElement===el,title:document.title,canvas:!!el}})()`,
  focusSettingsButton: `(()=>{const el=document.querySelector('button[aria-label="Toggle settings"]');if(!el)throw Error('exact Settings button is absent');el.focus();return {focused:document.activeElement===el,settingsPressed:el.getAttribute('aria-pressed'),active:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName}})()`,
  selectTerminalTab: `(()=>{const tabId=JSON.parse(process.argv[3]);const el=document.querySelector('[data-terminal-tab-id="'+CSS.escape(tabId)+'"] button[role="tab"]');if(!el)throw Error('exact terminal tab button is absent');el.click();return {clicked:true,tabId,selected:el.getAttribute('aria-selected')}})()`,
  install: `(()=>{window.__transportProbeEvents=[];window.__transportProbeListener=(e)=>{const token=e.key==='Unidentified'&&(e.keyCode===0||e.keyCode===252)&&(e.code===''||e.code==='Unidentified');if(!['CapsLock','A','a','H','h','F24'].includes(e.key)&&![20,65,72,135].includes(e.keyCode)&&!token)return;e.preventDefault();e.stopImmediatePropagation();window.__transportProbeEvents.push({type:e.type,key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,repeat:e.repeat,location:e.location,caps:e.getModifierState('CapsLock'),ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,defaultPrevented:e.defaultPrevented,time:performance.now()})};for(const type of ['keydown','keyup'])window.addEventListener(type,window.__transportProbeListener,true);return {installed:Array.isArray(window.__transportProbeEvents),title:document.title}})()`,
  removeCapture: `(()=>{if(window.__transportProbeListener)for(const type of ['keydown','keyup'])window.removeEventListener(type,window.__transportProbeListener,true);window.__transportProbeListener=null;return {removed:true}})()`,
  events: `({installed:Array.isArray(window.__transportProbeEvents),events:window.__transportProbeEvents||[]})`,
  clear: `(()=>{const count=window.__transportProbeEvents?.length??-1;window.__transportProbeEvents=[];return {cleared:true,count}})()`,
  syntheticCheck: `(()=>{const canvas=document.querySelector('canvas.output-canvas[tabindex="0"]');if(!canvas||document.activeElement!==canvas)throw Error('live canvas is not focused');const event=new KeyboardEvent('keydown',{key:'a',code:'KeyA',keyCode:65,which:65,bubbles:true,cancelable:true});const accepted=canvas.dispatchEvent(event);return {dispatchAccepted:accepted,defaultPrevented:event.defaultPrevented,count:window.__transportProbeEvents?.length??-1}})()`,
  probeSetup: `(async()=>{const api=window.__TAURI_INTERNALS__;if(!api?.invoke||!api?.transformCallback)throw Error('Tauri event bridge unavailable');window.__automationProbeNativeEvents=[];const registrations=[];for(const event of ['automation-probe-status','automation-probe-trace','automation-probe-layout-changed','automation-probe-layout-error']){const handler=api.transformCallback(data=>window.__automationProbeNativeEvents.push({event,payload:data.payload,time:performance.now()}));const id=await api.invoke('plugin:event|listen',{event,target:{kind:'Any'},handler});registrations.push({event,id})}window.__automationProbeNativeRegistrations=registrations;return {registered:registrations.map(item=>item.event)}})()`,
  probeReady: `(async()=>{const api=window.__TAURI_INTERNALS__;const frontendId=window.__scanlineAutomationProbe?.status?.frontendId;if(!frontendId)return {emitted:false,error:'frontendId is not available from the active probe instance'};try{await api.invoke('plugin:event|emit',{event:'automation-probe-ready',payload:{frontendId}});return {emitted:true,frontendId}}catch(error){return {emitted:false,error:String(error),stack:error?.stack||''}}})()`,
  probeTrace: `(async()=>{const api=window.__TAURI_INTERNALS__;try{await api.invoke('plugin:event|emit',{event:'automation-probe-trace-request',payload:null});return {requested:true}}catch(error){return {requested:false,error:String(error),stack:error?.stack||''}}})()`,
  probeLayoutRequest: `(async()=>{const api=window.__TAURI_INTERNALS__;const payload=JSON.parse(process.argv[3]);try{await api.invoke('plugin:event|emit',{event:'automation-probe-layout-request',payload});return {emitted:true,payload}}catch(error){return {emitted:false,error:String(error),stack:error?.stack||'',payload}}})()`,
  probeEvents: `({events:window.__automationProbeNativeEvents||[],registrations:window.__automationProbeNativeRegistrations||[]})`,
  probeClear: `(()=>{const count=window.__automationProbeNativeEvents?.length??-1;window.__automationProbeNativeEvents=[];return {cleared:true,count}})()`,
  frontendProbe: `(()=>{const p=window.__scanlineAutomationProbe;return p?{enabled:p.enabled,status:p.status,context:p.context,trace:[...p.trace]}:null})()`,
  terminalTabs: `(()=>({tabs:[...document.querySelectorAll('[data-terminal-tab-id]')].map(el=>({tabId:el.getAttribute('data-terminal-tab-id'),selected:el.querySelector('button[role="tab"]')?.getAttribute('aria-selected')==='true',label:el.querySelector('button[role="tab"]')?.innerText||''}))}))()`,
  cursorSnapshot: `(async()=>{const id=process.argv[3];const active=document.querySelector('[data-terminal-tab-id] button[role="tab"][aria-selected="true"]')?.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id');if(!id||active!==id)throw Error('requested MCP terminal session is not the active tab: '+JSON.stringify({requested:id,active}));const names=performance.getEntriesByType('resource').map(x=>x.name).filter(x=>x.includes('/src/terminal/TerminalSession.ts'));const attempts=[];for(const name of [...new Set([...names,'/src/terminal/TerminalSession.ts'])]){try{const mod=await import(new URL(name,location.href).href);const session=mod.terminalSession(id);if(!session?.terminal){attempts.push({name,found:!!session});continue}window.__cursorTraceByTab??={};window.__cursorTraceByTab[id]??=[];if(!session.__cursorTraceWrapped){const record=(source,data)=>{const bytes=typeof data==='string'?new TextEncoder().encode(data):data instanceof Uint8Array?data:Uint8Array.from(data||[]);const text=new TextDecoder().decode(bytes);const escapes=[...text.matchAll(/\\x1b(?:\\[[0-?]*[ -/]*[@-~]|.)/g)].map(match=>match[0]);const trace=window.__cursorTraceByTab[id];if(escapes.length&&trace.length<256)trace.push({source,at:performance.now(),escapes,byteLength:bytes.length,applicationCursorShape:session.applicationCursorShape,applicationCursorStyle:session.applicationCursorStyle,cursorStyleOverridden:session.cursorStyleOverridden,cursorStyle:session.cursorStyle,cursorBlink:session.cursorBlink})};const queueOutput=session.queueOutput;session.queueOutput=function(data){record('conpty-output',data);return queueOutput.call(this,data)};session.terminal.parser.registerCsiHandler({intermediates:' ',final:'q'},params=>{const trace=window.__cursorTraceByTab[id];if(trace.length<256)trace.push({source:'parser-observer',at:performance.now(),params:[...params],applicationCursorShape:session.applicationCursorShape,cursorStyle:session.cursorStyle});return false});session.__cursorTraceWrapped=true}const terminal=session.terminal;const snapshot=session.snapshot(false);return {tabId:id,title:session.title,processName:session.processName,applicationCursorShape:session.applicationCursorShape,applicationCursorStyle:session.applicationCursorStyle,cursorStyleOverridden:session.cursorStyleOverridden,sessionCursorStyle:session.cursorStyle,sessionCursorBlink:session.cursorBlink,xtermCursorStyle:terminal.options.cursorStyle,xtermCursorBlink:terminal.options.cursorBlink,decPrivateCursorStyle:terminal._coreService?.decPrivateModes?.cursorStyle,decPrivateCursorBlink:terminal._coreService?.decPrivateModes?.cursorBlink,screenLines:snapshot.screen.lines,rawSequences:[...(window.__cursorTraceByTab[id]||[])]}}catch(error){attempts.push({name,error:String(error)})}}throw Error('requested TerminalSession unavailable: '+JSON.stringify({id,attempts}))})()`,
  frontendProbeClear: `(()=>{const p=window.__scanlineAutomationProbe;if(!p)return {cleared:false,count:-1};const count=p.trace.length;p.trace.length=0;return {cleared:true,count}})()`,
  setTerminalVtMode: `(async()=>{const id=window.__scanlineAutomationProbe?.context?.tabId;if(!id)throw Error('active automation tab id is unavailable');const names=performance.getEntriesByType('resource').map(x=>x.name).filter(x=>x.includes('/src/terminal/TerminalSession.ts'));const candidates=[...new Set([...names,'/src/terminal/TerminalSession.ts'])];const attempts=[];for(const name of candidates){try{const mod=await import(new URL(name,location.href).href);const session=mod.terminalSession(id);attempts.push({name,found:!!session});if(session?.terminal){await new Promise(resolve=>session.terminal.write('\\x1b[?9001l',resolve));return {tabId:id,win32InputMode:session.win32InputMode,parserMode:'VT',source:'test-injected DECRQM/CSI ?9001l through active terminal parser',module:name}}}catch(error){attempts.push({name,error:String(error)})}}throw Error('active terminal session unavailable from loaded module URLs: '+JSON.stringify({id,attempts}))})()`,
  setTerminalWin32Mode: `(async()=>{const id=window.__scanlineAutomationProbe?.context?.tabId;if(!id)throw Error('active automation tab id is unavailable');const names=performance.getEntriesByType('resource').map(x=>x.name).filter(x=>x.includes('/src/terminal/TerminalSession.ts'));const candidates=[...new Set([...names,'/src/terminal/TerminalSession.ts'])];const attempts=[];for(const name of candidates){try{const mod=await import(new URL(name,location.href).href);const session=mod.terminalSession(id);attempts.push({name,found:!!session});if(session?.terminal){await new Promise(resolve=>session.terminal.write('\\x1b[?9001h',resolve));return {tabId:id,win32InputMode:session.win32InputMode,parserMode:'Win32',source:'test-injected DECRQM/CSI ?9001h through active terminal parser',module:name}}}catch(error){attempts.push({name,error:String(error)})}}throw Error('active terminal session unavailable from loaded module URLs: '+JSON.stringify({id,attempts}))})()`,
};
if (action === "reload") {
  try {
    await send("Page.reload", { ignoreCache: true });
    console.log(JSON.stringify({ target: { id: target.id, url: target.url, title: target.title }, result: { reloadRequested: true } }));
  } finally {
    ws.close();
  }
} else if (action === "installStartupDiagnostics") {
  try {
    const source = `(()=>{window.__probeStartupErrors=[];window.addEventListener('error',e=>window.__probeStartupErrors.push({type:'error',message:e.message,source:e.filename,line:e.lineno,col:e.colno,time:performance.now()}));window.addEventListener('unhandledrejection',e=>window.__probeStartupErrors.push({type:'unhandledrejection',reason:String(e.reason),time:performance.now()}));const old=console.error;console.error=(...args)=>{window.__probeStartupErrors.push({type:'console.error',message:args.map(String).join(' ').slice(0,1200),time:performance.now()});old.apply(console,args)}})()`;
    const result = await send("Page.addScriptToEvaluateOnNewDocument", { source });
    console.log(JSON.stringify({ target: { id: target.id, url: target.url, title: target.title }, result: { identifier: result.result?.identifier } }));
  } finally {
    ws.close();
  }
} else {
if (!(action in expressions)) throw new Error(`Unknown CDP action: ${action}`);
try {
  const expression = action === "restoreDevMcp" || action === "selectTerminalTab" || action === "probeLayoutRequest" || action === "cursorSnapshot"
    ? expressions[action].replace("process.argv[3]", JSON.stringify(process.argv[3] ?? "null"))
    : expressions[action];
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || "CDP expression threw");
  console.log(JSON.stringify({ target: { id: target.id, url: target.url, title: target.title }, result: result.result?.result?.value ?? result }));
} finally {
  ws.close();
}
}
