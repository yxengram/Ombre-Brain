
// The previous Lucide CDN dependency was display-only.  Keep its tiny public
// hook as a local no-op so existing render paths stay functional without any
// browser request to a third party.
window.lucide = window.lucide || { createIcons: function () {} };

// SVG icon strings — drop-in replacements for emoji in innerHTML
const _SV = {
  ok:     '<svg class="icon icon-ok"   aria-hidden="true"><use href="#i-check"></use></svg>',
  err:    '<svg class="icon icon-err"  aria-hidden="true"><use href="#i-x"></use></svg>',
  warn:   '<svg class="icon icon-warn" aria-hidden="true"><use href="#i-warn"></use></svg>',
  stop:   '<svg class="icon icon-err"  aria-hidden="true"><use href="#i-stop"></use></svg>',
  info:   '<svg class="icon"           aria-hidden="true"><use href="#i-info"></use></svg>',
  clock:  '<svg class="icon"           aria-hidden="true"><use href="#i-clock"></use></svg>',
  pause:  '<svg class="icon"           aria-hidden="true"><use href="#i-pause"></use></svg>',
  anchor: '<svg class="icon"           aria-hidden="true"><use href="#i-anchor"></use></svg>',
  pin:    '<svg class="icon"           aria-hidden="true"><use href="#i-pin"></use></svg>',
  edit:   '<svg class="icon"           aria-hidden="true"><use href="#i-edit"></use></svg>',
  coffee: '<svg class="icon"           aria-hidden="true"><use href="#i-coffee"></use></svg>',
  ribbon: '<svg class="icon"           aria-hidden="true"><use href="#i-ribbon"></use></svg>',
};
// ========================================
// HW-Switch helpers（胶囊开关同步）
// ========================================
function syncHwSwitch(sw, cbId) {
  var newState = sw.getAttribute('aria-checked') !== 'true';
  sw.setAttribute('aria-checked', newState ? 'true' : 'false');
  var cb = document.getElementById(cbId);
  if (cb) cb.checked = newState;
  var led = document.getElementById(cbId + '-led');
  if (led) led.classList.toggle('on', newState);
}
function syncSwFromCb(cbId, swId, ledId) {
  var cb  = document.getElementById(cbId);
  var sw  = document.getElementById(swId);
  var led = document.getElementById(ledId);
  var state = cb ? !!cb.checked : false;
  if (sw)  sw.setAttribute('aria-checked', state ? 'true' : 'false');
  if (led) led.classList.toggle('on', state);
}
function setHwSwitch(cbId, state) {
  var cb  = document.getElementById(cbId);
  var sw  = document.getElementById(cbId + '-sw');
  var led = document.getElementById(cbId + '-led');
  if (cb)  cb.checked = !!state;
  if (sw)  sw.setAttribute('aria-checked', state ? 'true' : 'false');
  if (led) led.classList.toggle('on', !!state);
}

// ========================================
// Auth system / 认证系统
// ========================================
var _dashboardAuthGeneration = 0;
var _authenticatedDashboardInitPromise = null;
var _authenticatedDashboardInitGeneration = -1;
var _heartbeatPollTimer = null;
var _anchorPollTimer = null;
var _errorAlertTimer = null;

function waitForDashboardDOM() {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise(function(resolve) {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });
}

function startAuthenticatedDashboardPolling() {
  if (_heartbeatPollTimer === null) {
    _heartbeatPollTimer = setInterval(pollHeartbeat, 15000);
  }
  if (_anchorPollTimer === null) {
    _anchorPollTimer = setInterval(refreshAnchorCounter, 30000);
  }
  if (_errorAlertTimer === null) {
    _errorAlertTimer = setInterval(pollCriticalErrors, 60000);
  }
}

function stopAuthenticatedDashboardPolling() {
  if (_heartbeatPollTimer !== null) clearInterval(_heartbeatPollTimer);
  if (_anchorPollTimer !== null) clearInterval(_anchorPollTimer);
  if (_errorAlertTimer !== null) clearInterval(_errorAlertTimer);
  _heartbeatPollTimer = null;
  _anchorPollTimer = null;
  _errorAlertTimer = null;
}

function invalidateAuthenticatedDashboardSession() {
  _dashboardAuthGeneration += 1;
  stopAuthenticatedDashboardPolling();
}

function initializeAuthenticatedDashboard(generation) {
  if (generation === undefined) generation = _dashboardAuthGeneration;
  if (
    _authenticatedDashboardInitPromise
    && _authenticatedDashboardInitGeneration === generation
  ) return _authenticatedDashboardInitPromise;

  var previous = _authenticatedDashboardInitPromise;
  var ready = previous
    ? previous.catch(function() { return null; })
    : Promise.resolve();
  var run = ready.then(waitForDashboardDOM).then(function() {
    if (generation !== _dashboardAuthGeneration) return [];
    startAuthenticatedDashboardPolling();
    var tasks = [
      loadBuckets(),
      loadStatusBanner(),
      syncRestartRequirement(),
      refreshAnchorCounter(),
      checkEmptyMemoryBanner(),
      loadOwnerBadge(),
      pollHeartbeat(),
      pollCriticalErrors(),
      maybeShowOnboarding(),
    ];
    if (typeof initSelfFab === 'function') tasks.push(initSelfFab());
    if (typeof refreshAuthenticatedActiveView === 'function') {
      tasks.push(Promise.resolve().then(refreshAuthenticatedActiveView));
    }
    return Promise.allSettled(tasks);
  });
  _authenticatedDashboardInitPromise = run;
  _authenticatedDashboardInitGeneration = generation;
  run.then(function() {
    if (_authenticatedDashboardInitPromise === run) {
      _authenticatedDashboardInitPromise = null;
      _authenticatedDashboardInitGeneration = -1;
    }
  }, function() {
    if (_authenticatedDashboardInitPromise === run) {
      _authenticatedDashboardInitPromise = null;
      _authenticatedDashboardInitGeneration = -1;
    }
  });
  return run;
}

function beginAuthenticatedDashboardSession() {
  _dashboardAuthGeneration += 1;
  return initializeAuthenticatedDashboard(_dashboardAuthGeneration);
}

async function finishDashboardAuthentication() {
  let sessionReady = false;
  try {
    const resp = await fetch('/auth/status', {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (resp.ok) {
      const data = await resp.json();
      sessionReady = data.authenticated === true;
    }
  } catch (_) { /* 统一在下方显示可操作的会话错误。 */ }
  if (!sessionReady) {
    invalidateAuthenticatedDashboardSession();
    document.getElementById('auth-overlay').style.display = 'flex';
    showAuthError('验证已通过，但浏览器未建立登录会话。请检查 nginx 的 Host、X-Forwarded-Proto 与 Set-Cookie 转发。');
    return false;
  }
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth-overlay').style.display = 'none';
  await beginAuthenticatedDashboardSession();
  return true;
}

async function checkAuth() {
  var requestedGeneration = _dashboardAuthGeneration;
  try {
    const resp = await fetch('/auth/status', { cache: 'no-store' });
    const data = await resp.json();
    if (requestedGeneration !== _dashboardAuthGeneration) return false;
    if (data.setup_needed) {
      invalidateAuthenticatedDashboardSession();
      document.getElementById('auth-subtitle').textContent = '首次设置 / First-time setup';
      document.getElementById('auth-setup-form').style.display = 'block';
      document.getElementById('auth-login-form').style.display = 'none';
      document.getElementById('auth-recovery-form').style.display = 'none';
      document.getElementById('auth-overlay').style.display = 'flex';
      return false;
    } else if (data.authenticated) {
      document.getElementById('auth-overlay').style.display = 'none';
      return true;
    } else {
      invalidateAuthenticatedDashboardSession();
      document.getElementById('auth-subtitle').textContent = '请输入访问密码 / Enter access password';
      document.getElementById('auth-login-form').style.display = 'block';
      document.getElementById('auth-overlay').style.display = 'flex';
      return false;
    }
  } catch {
    if (requestedGeneration !== _dashboardAuthGeneration) return false;
    document.getElementById('auth-overlay').style.display = 'none';
    return true;
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

async function readAuthFailure(resp, fallback) {
  try {
    const data = await resp.json();
    const error = data && typeof data.error === 'string' ? data.error : '';
    if (resp.status === 403 && error === 'Cross-origin request rejected') {
      return '反向代理来源校验失败（HTTP 403）。请让 nginx 保留 Host、X-Forwarded-Host、X-Forwarded-Proto，并配置 OMBRE_TRUSTED_PROXY_CIDRS。';
    }
    return error || fallback || ('登录请求失败（HTTP ' + resp.status + '）');
  } catch (_) {
    return '登录请求失败（HTTP ' + resp.status + '）：反向代理未返回 OB 的 JSON 响应，请检查 nginx 是否完整转发 /auth/*。';
  }
}

function showRecoveryCodes(codes, message) {
  if (!Array.isArray(codes) || codes.length !== 10) return;
  const box = document.getElementById('settings-recovery-codes');
  if (box) { box.textContent = codes.join('\n'); box.style.display = 'block'; }
  const msg = document.getElementById('settings-recovery-msg');
  if (msg) { msg.style.color = 'var(--warning)'; msg.textContent = message || '请立即离线保存恢复码。'; }
}

async function doSetup() {
  const p1 = document.getElementById('auth-setup-pwd').value;
  const p2 = document.getElementById('auth-setup-pwd2').value;
  if (p1.length < 15) return showAuthError('密码至少15位');
  if (p1 !== p2) return showAuthError('两次密码不一致');
  const resp = await fetch('/auth/setup', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({password: p1}) });
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    return showAuthError(d.error || '设置失败');
  }
  const data = await resp.json().catch(() => ({}));
  showRecoveryCodes(data.recovery_codes, '请立即离线保存这 10 个恢复码；它们只显示一次。');
  await finishDashboardAuthentication();
}

function showLogin() {
  document.getElementById('auth-recovery-form').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'block';
  document.getElementById('auth-subtitle').textContent = '请输入访问密码 / Enter access password';
  document.getElementById('auth-error').style.display = 'none';
}

async function showRecovery() {
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-recovery-form').style.display = 'block';
  document.getElementById('auth-subtitle').textContent = '急救模式 / Recovery mode';
  document.getElementById('auth-error').style.display = 'none';
}

async function doRecover() {
  const recovery_code = document.getElementById('auth-recovery-code').value;
  const newPwd = document.getElementById('auth-recovery-newpwd').value;
  if (newPwd.length < 15) return showAuthError('新密码至少15位');
  const resp = await fetch('/auth/recover', { method: 'POST', headers: {'Content-Type':'application/json'}, cache:'no-store', body: JSON.stringify({recovery_code, new_password: newPwd}) });
  if (resp.ok) {
    await finishDashboardAuthentication();
  } else {
    const d = await resp.json().catch(() => ({}));
    showAuthError(d.error || '验证失败');
  }
}

async function doLogin() {
  const pwd = document.getElementById('auth-login-pwd').value;
  let resp;
  try {
    resp = await fetch('/auth/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({password: pwd})
    });
  } catch (_) {
    return showAuthError('登录请求未到达 OB，请检查网络以及 nginx 是否完整转发 /auth/*。');
  }
  if (resp.ok) {
    return await finishDashboardAuthentication();
  } else {
    showAuthError(await readAuthFailure(resp, '登录失败（HTTP ' + resp.status + '）'));
    return false;
  }
}

async function doLogout() {
  await fetch('/auth/logout', { method: 'POST' });
  invalidateAuthenticatedDashboardSession();
  document.getElementById('auth-setup-form').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'block';
  document.getElementById('auth-subtitle').textContent = '请输入访问密码 / Enter access password';
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth-overlay').style.display = 'flex';
}

async function changePassword() {
  const currentPwd = document.getElementById('settings-current-pwd').value;
  const newPwd = document.getElementById('settings-new-pwd').value;
  const newPwd2 = document.getElementById('settings-new-pwd2').value;
  const msgEl = document.getElementById('settings-pwd-msg');
  if (newPwd.length < 15) { msgEl.style.color = 'var(--negative)'; msgEl.textContent = '新密码至少15位'; return; }
  if (newPwd !== newPwd2) { msgEl.style.color = 'var(--negative)'; msgEl.textContent = '两次密码不一致'; return; }
  const resp = await authFetch('/auth/change-password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({current: currentPwd, new: newPwd}) });
  if (!resp) return;
  if (resp.ok) {
    msgEl.style.color = 'var(--accent)'; msgEl.textContent = '密码修改成功';
    document.getElementById('settings-current-pwd').value = '';
    document.getElementById('settings-new-pwd').value = '';
    document.getElementById('settings-new-pwd2').value = '';
  } else {
    const d = await resp.json().catch(() => ({}));
    msgEl.style.color = 'var(--negative)'; msgEl.textContent = d.detail || '修改失败';
  }
}

async function regenerateRecoveryCodes() {
  const current_password = document.getElementById('settings-recovery-current-pwd').value;
  const msg = document.getElementById('settings-recovery-msg');
  const resp = await authFetch('/auth/recovery-codes/regenerate', { method: 'POST', headers: {'Content-Type':'application/json'}, cache:'no-store', body: JSON.stringify({current_password}) });
  if (!resp) return;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { msg.style.color = 'var(--negative)'; msg.textContent = data.error || '生成失败'; return; }
  document.getElementById('settings-recovery-current-pwd').value = '';
  showRecoveryCodes(data.recovery_codes, '旧恢复码已全部失效；请立即离线保存新码。');
}

// --- Cloudflare Tunnel ---
function _setTunnelUI(running, statusText, color, btnText, errText) {
  const dot = document.getElementById('tunnel-status-dot');
  const txt = document.getElementById('tunnel-status-text');
  const btn = document.getElementById('tunnel-toggle-btn');
  const errBox = document.getElementById('tunnel-error-box');
  if (dot) { dot.style.background = color; dot.classList.toggle('dot-on', !!running); }
  if (txt) { txt.style.color = color; txt.textContent = statusText; }
  if (btn) { btn.innerHTML = `<i data-lucide="play" style="width:14px;height:14px;vertical-align:-2px;"></i> ${btnText}`; if (window.lucide) lucide.createIcons({nodes:[btn]}); btn.disabled = false; }
  if (errBox) {
    if (errText) { errBox.style.display = ''; errBox.textContent = errText; }
    else { errBox.style.display = 'none'; errBox.textContent = ''; }
  }
}

async function loadTunnelStatus() {
  const resp = await authFetch('/api/tunnel/status');
  if (!resp || !resp.ok) return;
  const d = await resp.json();
  // A slower status poll must not overwrite the value while a save is in flight.
  if (!_tunnelAutoStartSaving) setHwSwitch('tunnel-autostart', d.auto_start);
  const authDanger = document.getElementById('tunnel-auth-danger');
  const authCaution = document.getElementById('tunnel-auth-caution');
  const tunnelActive = !!d.token_set;
  if (authDanger) authDanger.style.display = (tunnelActive && d.mcp_auth_required === false) ? '' : 'none';
  if (authCaution) authCaution.style.display = (tunnelActive && d.mcp_auth_required !== false && (d.mcp_auth_mode === 'token' || d.mcp_auth_mode === 'hybrid')) ? '' : 'none';
  if (d.running) {
    _setTunnelUI(true, '已连接 / Connected', 'var(--positive, #9DC880)', '停止', '');
  } else {
    const err = d.last_error || '';
    _setTunnelUI(false, err ? '连接失败 / Connection failed' : '未运行 / Not running',
      err ? 'var(--negative)' : 'var(--text-dim)', '启动', err);
  }
}

let _tunnelAutoStartSaving = false;
async function toggleTunnelAutoStart(sw) {
  if (_tunnelAutoStartSaving) return;

  const previous = sw.getAttribute('aria-checked') === 'true';
  syncHwSwitch(sw, 'tunnel-autostart');
  const autoStart = document.getElementById('tunnel-autostart').checked;
  const msgEl = document.getElementById('tunnel-msg');

  _tunnelAutoStartSaving = true;
  sw.setAttribute('aria-disabled', 'true');
  try {
    const resp = await authFetch('/api/tunnel/config', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({auto_start: autoStart})
    });
    if (!resp) throw new Error('登录状态已失效');
    const data = await readJsonSafe(resp);
    if (!resp.ok) throw new Error(data.error || '保存失败');

    if (!data.persisted) throw new Error('服务端未确认配置已持久化');
    setHwSwitch('tunnel-autostart', !!data.auto_start);
    msgEl.style.color = 'var(--accent)';
    msgEl.textContent = data.auto_start ? '已启用启动时自动连接' : '已关闭启动时自动连接';
    setTimeout(() => { msgEl.textContent = ''; }, 3000);
  } catch (e) {
    setHwSwitch('tunnel-autostart', previous);
    msgEl.style.color = 'var(--negative)';
    msgEl.textContent = '自动连接设置保存失败: ' + e.message;
  } finally {
    _tunnelAutoStartSaving = false;
    sw.removeAttribute('aria-disabled');
  }
}

async function saveTunnelToken() {
  const token = document.getElementById('tunnel-token-input').value.trim();
  const autoStart = document.getElementById('tunnel-autostart').checked;
  const msgEl = document.getElementById('tunnel-msg');
  if (!token) { msgEl.style.color = 'var(--negative)'; msgEl.textContent = '请先粘贴 Token'; return; }
  const resp = await authFetch('/api/tunnel/config', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({token, auto_start: autoStart})
  });
  if (!resp) return;
  if (resp.ok) {
    const data = await readJsonSafe(resp);
    setHwSwitch('tunnel-autostart', !!data.auto_start);
    msgEl.style.color = 'var(--accent)'; msgEl.innerHTML = _SV.ok + ' Token 已保存，点击"启动"连接';
    document.getElementById('tunnel-token-input').value = '';
    setTimeout(() => { msgEl.textContent = ''; }, 4000);
  } else {
    msgEl.style.color = 'var(--negative)'; msgEl.textContent = '保存失败';
  }
}

let _tunnelPollTimer = null;
async function toggleTunnel() {
  const btn = document.getElementById('tunnel-toggle-btn');
  const isRunning = btn.textContent.trim() === '停止';
  btn.disabled = true;
  if (_tunnelPollTimer) { clearInterval(_tunnelPollTimer); _tunnelPollTimer = null; }

  if (isRunning) {
    const resp = await authFetch('/api/tunnel/stop', {method: 'POST'});
    if (!resp) return;
    _setTunnelUI(false, '未运行 / Not running', 'var(--text-dim)', '启动', '');
  } else {
    // Check token set
    const statusResp = await authFetch('/api/tunnel/status');
    if (!statusResp) return;
    const sd = await statusResp.json();
    if (!sd.token_set) {
      const msgEl = document.getElementById('tunnel-msg');
      msgEl.style.color = 'var(--negative)'; msgEl.textContent = '请先填写并保存 Token';
      btn.disabled = false;
      return;
    }
    _setTunnelUI(false, '连接中… / Connecting…', '#f0a500', '连接中… / Connecting…', '');
    const resp = await authFetch('/api/tunnel/start', {method: 'POST'});
    if (!resp) { _setTunnelUI(false, '未运行 / Not running', 'var(--text-dim)', '启动', ''); return; }
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      _setTunnelUI(false, '启动失败', 'var(--negative)', '启动', d.error || '启动失败');
      return;
    }
    // Poll for 20s to see if cloudflared stays alive
    let polls = 0;
    _tunnelPollTimer = setInterval(async () => {
      polls++;
      await loadTunnelStatus();
      const dot = document.getElementById('tunnel-status-dot');
      const isConnected = dot && dot.style.background.includes('4caf50');
      const isFailed = document.getElementById('tunnel-status-text')?.textContent === '连接失败';
      if (isConnected || isFailed || polls >= 10) {
        clearInterval(_tunnelPollTimer); _tunnelPollTimer = null;
      }
    }, 2000);
  }
}

function onDehyFormatChange() {
  var fmt = (document.getElementById('cfg-dehy-format') || {value:'openai_compat'}).value;
  var urlRow = document.getElementById('cfg-dehy-url-row');
  if (urlRow) urlRow.style.display = fmt === 'gemini' ? 'none' : '';
}

function onEmbFormatChange() {
  var fmt = (document.getElementById('cfg-emb-format') || {value:'openai_compat'}).value;
  var urlRow = document.getElementById('cfg-emb-url-row');
  var urlHint = document.getElementById('cfg-emb-url-hint');
  var isGemini = fmt === 'gemini';
  if (urlRow) urlRow.style.display = isGemini ? 'none' : '';
  if (urlHint) urlHint.style.display = isGemini ? 'none' : '';
}

async function fetchModels(section) {
  // section: 'dehy' | 'env-compress' | 'emb'
  var apiKey, baseUrl, apiFormat, modelInputId, listId, keyIsAlreadySaved;

  if (section === 'dehy') {
    apiKey = (document.getElementById('cfg-dehy-key') || {value:''}).value.trim();
    baseUrl = (document.getElementById('cfg-dehy-url') || {value:''}).value.trim();
    apiFormat = (document.getElementById('cfg-dehy-format') || {value:'openai_compat'}).value;
    modelInputId = 'cfg-dehy-model';
    listId = 'cfg-dehy-model-list';
    // Key is saved if placeholder shows a masked value (set by refreshEnvConfig)
    var ph = (document.getElementById('cfg-dehy-key') || {placeholder:''}).placeholder;
    keyIsAlreadySaved = ph && ph.indexOf('当前:') !== -1;
  } else if (section === 'emb') {
    apiKey = (document.getElementById('cfg-emb-api-key') || {value:''}).value.trim();
    baseUrl = (document.getElementById('cfg-emb-base-url') || {value:''}).value.trim();
    // gemini native → use gemini_embed (filters embedContent models); openai_compat → use openai_compat
    var embFmt = (document.getElementById('cfg-emb-format') || {value:'openai_compat'}).value;
    apiFormat = embFmt === 'gemini' ? 'gemini_embed' : 'openai_compat';
    modelInputId = 'cfg-emb-model';
    listId = 'cfg-emb-model-list';
    var ph2 = (document.getElementById('cfg-emb-api-key') || {placeholder:''}).placeholder;
    keyIsAlreadySaved = ph2 && ph2.indexOf('当前:') !== -1;
  } else {
    apiKey = (document.getElementById('env-compress-key') || {value:''}).value.trim();
    baseUrl = (document.getElementById('env-compress-base') || {value:''}).value.trim();
    apiFormat = (document.getElementById('env-compress-format') || {value:'openai_compat'}).value;
    modelInputId = 'env-compress-model';
    listId = 'env-compress-model-list';
    var ph3 = (document.getElementById('env-compress-key') || {placeholder:''}).placeholder;
    keyIsAlreadySaved = ph3 && ph3.indexOf('当前：') !== -1;
  }

  var listEl = document.getElementById(listId);
  if (!listEl) return;

  // Key validation: must have a key typed OR a key already saved on server
  if (!apiKey && !keyIsAlreadySaved) {
    listEl.style.display = 'block';
    listEl.innerHTML = '<div style="padding:8px 12px;color:var(--warning);">' + _SV.warn + ' 请先输入并保存 API Key，再获取模型列表</div>';
    return;
  }

  // Use sentinel to let backend read current server-side key (when no key typed but one is saved)
  var effectiveKey = apiKey || (section === 'emb' ? '__use_current_embed__' : '__use_current__');

  listEl.style.display = 'block';
  listEl.innerHTML = '<div style="padding:6px 10px;color:var(--text-dim);">获取中…</div>';
  try {
    var payload = { api_key: effectiveKey, base_url: baseUrl, api_format: apiFormat };
    var r = await authFetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r) { listEl.style.display = 'none'; return; }
    var d = await readJsonSafe(r);
    if (!d.ok || !d.models || !d.models.length) {
      listEl.innerHTML = '<div style="padding:8px 12px;color:var(--negative);">' + _SV.err + ' ' + esc(d.error || '无可用模型') + '</div>';
      return;
    }
    listEl.innerHTML = d.models.map(function(m) {
      m = String(m || '');
      return '<div style="padding:5px 10px;cursor:pointer;border-bottom:1px solid rgba(150,138,116,0.12);" ' +
        'data-ob-mouseenter="this.style.background%3D%5C%27var%28--accent-glow%29%5C%27" ' +
        'data-ob-mouseleave="this.style.background%3D%5C%27%5C%27" ' +
        'data-model="' + escAttr(m) + '" data-input-id="' + escAttr(modelInputId) + '" ' +
        'data-list-id="' + escAttr(listId) + '" data-ob-click="selectRemoteModelOption%28this%29">' +
        esc(m) + '</div>';
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div style="padding:8px 12px;color:var(--negative);">' + _SV.err + ' ' + esc(e.message) + '</div>';
  }
}

function selectRemoteModelOption(option) {
  var input = document.getElementById(option.dataset.inputId || '');
  var list = document.getElementById(option.dataset.listId || '');
  if (input) input.value = option.dataset.model || '';
  if (list) list.style.display = 'none';
}

async function testDehydrationKey() {
  const msgEl = document.getElementById('dehy-key-msg');
  msgEl.style.color = 'var(--text-dim)'; msgEl.textContent = '测试中… / Testing…';
  const resp = await authFetch('/api/test/dehydration', {method: 'POST'});
  if (!resp) return;
  const d = await resp.json().catch(() => ({}));
  if (d.ok) {
    msgEl.style.color = 'var(--positive, #9DC880)'; msgEl.innerHTML = _SV.ok + ' ' + esc(d.message || '连接成功');
  } else {
    msgEl.style.color = 'var(--negative)'; msgEl.innerHTML = _SV.err + ' ' + esc(d.error || '连接失败');
    chickReactForApiProblem(d.error);
  }
}

async function testEmbeddingKey() {
  const msgEl = document.getElementById('emb-key-msg');
  if (!msgEl) return;
  msgEl.style.color = 'var(--text-dim)'; msgEl.textContent = '测试中… / Testing…';
  const resp = await authFetch('/api/test/embedding', {method: 'POST'});
  if (!resp) return;
  const d = await resp.json().catch(() => ({}));
  if (d.ok) {
    msgEl.style.color = 'var(--positive, #9DC880)'; msgEl.innerHTML = _SV.ok + ' ' + esc(d.message || '向量化连接成功');
  } else {
    msgEl.style.color = 'var(--negative)'; msgEl.innerHTML = _SV.err + ' ' + esc(d.error || '向量化连接失败');
    chickReactForApiProblem(d.error);
  }
}

async function loadSettingsStatus() {
  const el = document.getElementById('settings-status');
  try {
    const resp = await authFetch('/api/status');
    if (!resp) return;
    const d = await resp.json();
    const noticeEl = document.getElementById('settings-env-notice');
    if (d.using_env_password) noticeEl.style.display = 'block';
    else noticeEl.style.display = 'none';
    el.innerHTML = `
      <b>版本</b>：${esc(d.version)}<br>
      <b>Bucket 总数</b>：${Number(d.buckets?.total ?? 0)} （永久:${Number(d.buckets?.permanent ?? 0)} / 动态:${Number(d.buckets?.dynamic ?? 0)} / 归档:${Number(d.buckets?.archive ?? 0)}）<br>
      <b>衰减引擎</b>：${esc(d.decay_engine)}<br>
      <b>向量搜索</b>：${d.embedding_enabled ? '已启用' : '未启用'}<br>
    `;
    if (d.decay_engine === 'running' && window.ObPet) window.ObPet.react('decay');
  } catch(e) {
    el.textContent = '加载失败: ' + e;
  }
  await loadTunnelStatus();
}

function diagnosticStatusLabel(status) {
  if (status === 'ok') return '正常';
  if (status === 'warning') return '提醒';
  if (status === 'error') return '需处理';
  return status || '未知';
}

function diagnosticStatusColor(status) {
  if (status === 'ok') return 'var(--positive,#87A987)';
  if (status === 'warning') return 'var(--warning,#B89762)';
  if (status === 'error') return 'var(--negative,#BE5A41)';
  return 'var(--text-dim)';
}

// 体检项标签中文化：后端 id → 中文（主）+ 英文（小字）。普通人看不懂 surface context /
// migration preservation 这类词，面板里一律给中文；英文留作小字副标题，方便对照日志。
var DIAG_LABELS = {
  storage:                   ['数据目录', 'Storage'],
  buckets:                   ['记忆桶', 'Buckets'],
  ledger:                    ['事件账本', 'Ledger'],
  observability_boundary:    ['可观测性边界', 'Observability'],
  public_tool_manifest:      ['公开工具清单', 'Tool Manifest'],
  adr_requirements:          ['架构决策记录', 'ADR'],
  code_standards:            ['代码规范', 'Code Standards'],
  red_lines:                 ['红线约束', 'Red Lines'],
  crash_recovery:            ['崩溃恢复', 'Crash Recovery'],
  replication_contract:      ['复制契约', 'Replication'],
  migration_preservation:    ['迁移保真', 'Migration'],
  surface_context:           ['浮现上下文', 'Surface Context'],
  preflight_cli_diagnostics: ['预检 CLI', 'Preflight CLI'],
  vnext_preflight:           ['vNext 预检', 'vNext Preflight'],
  preflight_report_self:     ['预检自检', 'Preflight Self'],
  vnext_coverage:            ['vNext 覆盖率', 'vNext Coverage'],
  llm:                       ['压缩 / 打标 LLM', 'Compression LLM'],
  embedding:                 ['向量化', 'Embedding'],
  integrity:                 ['数据完整性', 'Integrity'],
  github:                    ['GitHub 备份', 'GitHub Backup'],
  auth:                      ['访问控制', 'Access Control'],
  runtime:                   ['运行时', 'Runtime'],
};
function diagLabelHtml(check) {
  var m = DIAG_LABELS[check.id];
  if (m) return esc(m[0]) + ' <span class="en">' + esc(m[1]) + '</span>';
  return esc(check.label || check.id || '检查项');
}

// 开发者 vs 用户：这些是内部工程/契约检查（事件账本、契约、vNext 迁移预检、代码规范、ADR…），
// 检的是我们开发者的东西，跟用户的记忆好不好无关 → 不在用户面板正文露出，折叠进「开发者诊断」。
// 用户相关的只有：数据目录 / 记忆桶 / 压缩LLM / 向量化 / 数据完整性 / GitHub备份 / 访问控制 / 运行时。
var DIAG_DEV_IDS = {
  ledger: 1, observability_boundary: 1, public_tool_manifest: 1, adr_requirements: 1,
  code_standards: 1, red_lines: 1, crash_recovery: 1, replication_contract: 1,
  migration_preservation: 1, surface_context: 1, preflight_cli_diagnostics: 1,
  vnext_preflight: 1, preflight_report_self: 1, vnext_coverage: 1,
};
function isDevCheck(c) { return !!DIAG_DEV_IDS[c && c.id]; }

// 面板只回答「好不好」：状态灯 + 一句人话 + 建议。
// 所有原始 details（schema 名、字段路径、missing_files、嵌套 JSON）都属于日志，
// 一律折叠进「查看详情」，绝不内联到面板主体，也绝不出现 [object Object]。
function renderDiagnosticCheck(check) {
  const color = diagnosticStatusColor(check.status);
  const details = check.details || {};
  let hasDetails = false;
  for (const k in details) {
    const v = details[k];
    if (v !== null && v !== undefined && v !== '') { hasDetails = true; break; }
  }
  let detailBlock = '';
  if (hasDetails) {
    let pretty = '';
    try { pretty = JSON.stringify(details, null, 2); } catch (e) { pretty = ''; }
    detailBlock = '<details style="margin-top:5px;">'
      + '<summary style="cursor:pointer;color:var(--accent);font-size:11px;user-select:none;">查看详情 · Details</summary>'
      + '<pre style="margin-top:5px;padding:8px 10px;background:var(--surface);border-radius:6px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--text-dim);font-family:\'Share Tech Mono\',\'SF Mono\',Consolas,monospace;">'
      + esc(pretty) + '</pre></details>';
  }
  return '<div style="border-left:3px solid ' + color + ';padding:9px 11px;background:var(--surface-solid);border-radius:8px;font-size:12px;line-height:1.6;box-shadow:inset 1px 1px 3px var(--shadow-dark-subtle),inset -1px -1px 3px var(--shadow-light);">'
    + '<div style="display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap;">'
    + '<strong style="font-size:13px;color:var(--text);">' + diagLabelHtml(check) + '</strong>'
    + '<span style="color:' + color + ';font-weight:600;">' + diagnosticStatusLabel(check.status) + '</span>'
    + '</div>'
    + '<div style="color:var(--text-dim);margin-top:3px;">' + esc(check.message || '') + '</div>'
    + (check.action ? '<div style="color:var(--accent);margin-top:3px;">建议：' + esc(check.action) + '</div>' : '')
    + detailBlock
    + '</div>';
}

async function loadSystemDiagnostics() {
  const summaryEl = document.getElementById('system-diagnostics-summary');
  const listEl = document.getElementById('system-diagnostics-list');
  const updatedEl = document.getElementById('system-diagnostics-updated');
  if (!summaryEl || !listEl) return;
  summaryEl.style.color = 'var(--text-dim)';
  summaryEl.textContent = '体检中… / Running diagnostics…';
  listEl.innerHTML = '';
  try {
    const resp = await authFetch('/api/system/diagnostics');
    if (!resp) return;
    const d = await readJsonSafe(resp);
    const checks = d.checks || [];
    const userChecks = checks.filter(function (c) { return !isDevCheck(c); });
    const devChecks = checks.filter(isDevCheck);
    // 用户摘要只统计用户相关项（开发者项不该影响用户看到的「好不好」）
    var us = { ok: 0, warning: 0, error: 0 };
    userChecks.forEach(function (c) { if (us[c.status] != null) us[c.status]++; });
    const allOk = us.error === 0 && us.warning === 0;
    summaryEl.style.color = allOk ? 'var(--positive,#87A987)' : 'var(--negative,#BE5A41)';
    summaryEl.innerHTML = (allOk ? _SV.ok + ' ' : _SV.warn + ' ')
      + '正常 ' + us.ok + ' · 提醒 ' + us.warning + ' · 需处理 ' + us.error;
    var html = userChecks.length
      ? userChecks.map(renderDiagnosticCheck).join('')
      : '<div style="font-size:12px;color:var(--text-dim);">没有返回体检项。</div>';
    // 开发者诊断：折叠到底部，普通用户不受打扰，devs 需要时点开
    if (devChecks.length) {
      var devOk = devChecks.filter(function (c) { return c.status === 'ok'; }).length;
      html += '<details style="margin-top:14px;">'
        + '<summary style="cursor:pointer;color:var(--text-light);font-size:12px;user-select:none;">开发者诊断 · Developer checks（' + devOk + '/' + devChecks.length + ' 正常）</summary>'
        + '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">'
        + devChecks.map(renderDiagnosticCheck).join('')
        + '</div></details>';
    }
    listEl.innerHTML = html;
    if (updatedEl) updatedEl.textContent = '刚刚刷新 ' + new Date().toLocaleTimeString();
  } catch(e) {
    summaryEl.style.color = 'var(--negative)';
    summaryEl.textContent = '体检失败：' + (e && e.message ? e.message : e);
  }
}

// ====== P1 常驻系统状态条 ======
// 只有这几项对应用户能自己动手改的设置字段；其余（契约 / 开发类检查）一律「查看详情」跳到设置体检。
const SB_ACTION_TARGETS = {
  embedding: { field: 'cfg-emb-api-key' },   // 向量化 Key
  llm:       { field: 'cfg-dehy-key' },       // 压缩 / 打标 LLM Key
  github:    { field: 'sec-github' },          // GitHub 备份区
};

// P3 设置分组子 tab：切换「常规 / 高级 / 备份与迁移」。
function showSettingsGroup(name) {
  const view = document.getElementById('settings-view');
  if (!view) return;
  view.setAttribute('data-active-sgroup', name);
  document.querySelectorAll('.settings-subtab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-sgroup') === name);
  });
}
// 找到某元素所在的设置分组并激活它——「前往处理」的目标字段可能藏在「高级」分组里，
// 隐藏的元素无法 scrollIntoView，必须先把它所在的分组切出来。
function ensureSettingsGroupFor(el) {
  const sec = (el && el.closest) ? el.closest('.config-section[data-sgroup]') : null;
  if (sec) showSettingsGroup(sec.getAttribute('data-sgroup'));
}

// 跳到设置里某个具体字段并高亮闪烁——把「需处理」卡片直接落到该改的地方。
function scrollToField(elId) {
  document.querySelector('[data-tab=settings]')?.click();
  setTimeout(function () {
    const el = document.getElementById(elId);
    if (!el) return;
    ensureSettingsGroupFor(el);   // 先切到该字段所在分组，再滚动
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('field-flash');
    void el.offsetWidth; // 强制 reflow，重启动画
    el.classList.add('field-flash');
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
    setTimeout(function () { el.classList.remove('field-flash'); }, 1900);
  }, 260);
}

// 「查看详情」：跳到设置 → 系统体检，并跑一次完整体检。
function gotoDiagnostics() {
  document.querySelector('[data-tab=settings]')?.click();
  setTimeout(function () {
    const s = document.getElementById('sec-service');
    if (s) { ensureSettingsGroupFor(s); s.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (typeof loadSystemDiagnostics === 'function') loadSystemDiagnostics();
  }, 260);
}

function toggleStatusBanner() {
  const b = document.getElementById('status-banner');
  if (!b) return;
  if (b.getAttribute('data-state') === 'ok') { gotoDiagnostics(); return; }
  b.classList.toggle('open');
}

// 顶栏会随窗口宽度、按钮换行和字体加载改变高度，状态条不能使用固定偏移。
var _statusHeaderResizeObserver = null;
function syncStatusBannerOffset() {
  const header = document.querySelector('.header');
  if (!header) return;
  const height = Math.ceil(header.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--ob-header-height', height + 'px');
}
function watchStatusBannerOffset() {
  const header = document.querySelector('.header');
  if (!header) return;
  syncStatusBannerOffset();
  if (typeof ResizeObserver === 'function') {
    _statusHeaderResizeObserver = new ResizeObserver(syncStatusBannerOffset);
    _statusHeaderResizeObserver.observe(header);
  } else {
    window.addEventListener('resize', syncStatusBannerOffset);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchStatusBannerOffset, { once: true });
} else {
  watchStatusBannerOffset();
}

function renderStatusBannerCard(check) {
  const color = check.status === 'error' ? 'var(--negative)' : 'var(--warning)';
  const target = SB_ACTION_TARGETS[check.id];
  const btn = (target && target.field)
    ? '<button class="sb-card-btn" data-ob-action="scroll-field" data-field="' + escAttr(target.field) + '">前往处理</button>'
    : '<button class="sb-card-btn ghost" data-ob-click="gotoDiagnostics%28%29">查看详情</button>';
  return '<div class="sb-card" style="--c:' + color + '">'
    + '<span class="sb-card-dot"></span>'
    + '<div class="sb-card-main">'
    + '<div class="sb-card-title">' + diagLabelHtml(check) + '</div>'
    + '<div class="sb-card-msg">' + esc(check.message || '') + '</div>'
    + '</div>' + btn + '</div>';
}

async function loadStatusBanner() {
  const banner = document.getElementById('status-banner');
  if (!banner) return;
  const textEl = document.getElementById('sb-text');
  const countEl = document.getElementById('sb-count');
  const bodyEl = document.getElementById('sb-body');
  banner.setAttribute('data-state', 'loading');
  banner.classList.remove('open');
  textEl.textContent = '体检中… / Checking…';
  countEl.textContent = '';
  bodyEl.innerHTML = '';
  try {
    const resp = await authFetch('/api/system/diagnostics');
    if (!resp) { banner.setAttribute('data-state', 'hidden'); return; }
    const d = await readJsonSafe(resp);
    // 状态条只看用户相关项：开发者契约检查不该让用户「需处理」告警
    const checks = (d.checks || []).filter(function (c) { return !isDevCheck(c); });
    const total = checks.length;
    const problems = checks.filter(function (c) { return c.status === 'error' || c.status === 'warning'; });
    problems.sort(function (a, b) { return (a.status === 'error' ? 0 : 1) - (b.status === 'error' ? 0 : 1); });
    if (problems.length === 0) {
      banner.setAttribute('data-state', 'ok');
      textEl.innerHTML = '<b>系统正常</b> · OK';
      countEl.textContent = total + ' 项检查全部通过';
      return;
    }
    const nErr = problems.filter(function (c) { return c.status === 'error'; }).length;
    banner.setAttribute('data-state', nErr ? 'error' : 'warn');
    textEl.innerHTML = '<b>' + problems.length + ' 项需处理</b> · Action Needed';
    countEl.textContent = '其余 ' + (total - problems.length) + ' 项正常';
    bodyEl.innerHTML = problems.map(renderStatusBannerCard).join('');
    banner.classList.add('open');
  } catch (e) {
    banner.setAttribute('data-state', 'hidden');
  }
}

// 修复钉选计数：先 GET 预演拿孤儿数 → 确认 → POST 实际降级。
async function fixPinnedDesync() {
  const msgEl = document.getElementById('fix-pinned-msg');
  if (!msgEl) return;
  msgEl.style.color = 'var(--text-dim)'; msgEl.textContent = '检查中… / Checking…';
  try {
    const presp = await authFetch('/api/maintenance/fix-pinned-desync');
    if (!presp) return;
    const pd = await readJsonSafe(presp);
    if (!pd.ok) { msgEl.style.color = 'var(--negative)'; msgEl.innerHTML = _SV.err + ' ' + esc(pd.error || '检查失败'); return; }
    const n = (pd.orphans || []).length;
    if (n === 0) {
      msgEl.style.color = 'var(--positive, #9DC880)';
      msgEl.innerHTML = _SV.ok + ` 计数已对齐，当前钉选 ${pd.pinned} 个，无需修复`;
      return;
    }
    if (!confirm(`发现 ${n} 个孤儿固化桶（已取消钉选却没降级）。\n将把它们降级回动态桶（释放配额、解开权重卡死），不会删除内容。是否继续？\n\nFound ${n} orphaned pinned bucket(s). They will be demoted back to dynamic (freeing quota, unblocking weight). Continue?`)) {
      msgEl.style.color = 'var(--text-dim)'; msgEl.textContent = '已取消';
      return;
    }
    msgEl.textContent = '修复中… / Fixing…';
    const aresp = await authFetch('/api/maintenance/fix-pinned-desync', { method: 'POST' });
    if (!aresp) return;
    const ad = await readJsonSafe(aresp);
    if (!ad.ok) { msgEl.style.color = 'var(--negative)'; msgEl.innerHTML = _SV.err + ' ' + esc(ad.error || '修复失败'); return; }
    msgEl.style.color = 'var(--positive, #9DC880)';
    msgEl.innerHTML = _SV.ok + ` 已降级 ${ad.demoted} 个` + (ad.failed ? `，失败 ${ad.failed} 个` : '') + `，现在钉选 ${ad.pinned} 个`;
    await loadSettingsStatus();
  } catch (e) {
    msgEl.style.color = 'var(--negative)'; msgEl.innerHTML = _SV.err + ' ' + esc(e.message || String(e));
  }
}

// #6: 环境变量面板
async function loadEnvVars() {
  const listEl = document.getElementById('env-vars-list');
  const summaryEl = document.getElementById('env-vars-summary');
  if (!listEl) return;
  listEl.innerHTML = '<span style="color:var(--text-dim);">加载中…</span>';
  try {
    const resp = await authFetch('/api/env-vars');
    if (!resp) return;
    const d = await resp.json();
    const vars = d.vars || [];
    const setCount = vars.filter(v => v.set).length;
    summaryEl.textContent = `共 ${vars.length} 个变量，已配置 ${setCount} 个`;

    const groups = [
      { key: 'llm', label: 'LLM / 压缩' },
      { key: 'embed', label: 'Embedding / 向量化' },
      { key: 'paths', label: '路径 / Paths' },
      { key: 'system', label: '服务配置 / Service config' },
      { key: 'webhook', label: 'Webhook' },
      { key: 'auth', label: '鉴权 / Auth' },
    ];

    let html = '';
    for (const grp of groups) {
      const items = vars.filter(v => v.group === grp.key);
      if (!items.length) continue;
      html += `<div style="margin-bottom:14px;">
        <div style="font-weight:600;color:var(--text-dim);letter-spacing:0.05em;font-size:11px;text-transform:uppercase;margin-bottom:6px;">${grp.label}</div>
        <table style="width:100%;border-collapse:collapse;">`;
      for (const v of items) {
        const nameCell = `<code style="font-size:11px;">${esc(v.name)}</code>`;
        let valCell;
        if (v.sensitive) {
          valCell = v.set
            ? `<span style="color:var(--positive);">已配置 ${_SV.ok}</span>`
            : `<span style="color:var(--text-dim);">未配置 —</span>`;
        } else {
          valCell = v.value != null
            ? `<span style="color:var(--accent);font-family:monospace;">${esc(v.value)}</span>`
            : `<span style="color:var(--text-dim);">（未设置）</span>`;
        }
        html += `<tr style="border-bottom:1px solid var(--border);">
          <td style="padding:5px 8px 5px 0;width:55%;vertical-align:middle;">${nameCell}<br/><span style="color:var(--text-dim);font-size:11px;">${esc(v.label)}</span></td>
          <td style="padding:5px 0;vertical-align:middle;">${valCell}</td>
        </tr>`;
      }
      html += `</table></div>`;
    }
    listEl.innerHTML = html;
  } catch(e) {
    listEl.innerHTML = `<span style="color:var(--negative);">加载失败: ${esc(e && e.message ? e.message : e)}</span>`;
  }
}

// iter 1.9 B: 加权采样面板 / weighted sampling control panel
async function loadSamplingSettings() {
  const msg = document.getElementById('sampling-msg');
  if (!msg) return;
  try {
    const resp = await authFetch('/api/settings/sampling');
    if (!resp) return;
    const d = await readJsonSafe(resp);
    setHwSwitch('sampling-enabled', !!d.enabled);
    document.getElementById('sampling-topk').value = d.top_k;
    document.getElementById('sampling-samplek').value = d.sample_k;
    document.getElementById('sampling-temp').value = d.temperature;
    document.getElementById('sampling-temp-val').textContent = d.temperature;
  } catch(e) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '加载失败: ' + e;
  }
}

async function saveSamplingSettings() {
  const msg = document.getElementById('sampling-msg');
  msg.style.color = 'var(--text-dim)';
  msg.textContent = '保存中… / Saving…';
  const body = {
    enabled: document.getElementById('sampling-enabled').checked,
    top_k: parseInt(document.getElementById('sampling-topk').value, 10),
    sample_k: parseInt(document.getElementById('sampling-samplek').value, 10),
    temperature: parseFloat(document.getElementById('sampling-temp').value),
  };
  try {
    const resp = await authFetch('/api/settings/sampling', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!resp) return;
    const d = await readJsonSafe(resp);
    if (resp.ok) {
      msg.style.color = 'var(--accent)';
      msg.textContent = '已保存（仅热更新到内存）';
    } else {
      msg.style.color = 'var(--negative)';
      msg.textContent = d.error || '保存失败';
    }
  } catch(e) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '保存失败: ' + e;
  }
}

async function testSamplingBreath() {
  const out = document.getElementById('sampling-test-result');
  out.textContent = 'breath 中…';
  try {
    const resp = await authFetch('/api/breath?n=5');
    if (!resp) return;
    const d = await readJsonSafe(resp);
    const items = (d.buckets || d.results || []).slice(0, 5);
    if (!items.length) {
      out.textContent = '没有候选桶（库可能是空的）';
      return;
    }
    out.innerHTML = '本次浮现：<br/>' + items.map((b, i) => {
      const nm = esc(b.name || b.id || '(无名)');
      const sc = (b.score != null) ? ' · ' + Number(b.score).toFixed(3) : '';
      return (i + 1) + '. ' + nm + sc;
    }).join('<br/>');
  } catch(e) {
    out.textContent = '失败: ' + e;
  }
}

// 工具箱已合并进「设置」（方案 A）：采样开关在「桶行为」、外网访问在「我」、
// 立即备份在「GitHub 同步」。原 tool* 开关/动作函数连同 Toolbox tab 一并移除。

async function loadHostVault() {
  const input = document.getElementById('settings-host-vault');
  const msg = document.getElementById('settings-host-vault-msg');
  const saveBtn = document.getElementById('settings-host-vault-save');
  if (!input) return;
  input.readOnly = false;
  if (saveBtn) saveBtn.disabled = false;
  msg.textContent = '';
  msg.style.color = 'var(--text-dim)';
  try {
    const resp = await authFetch('/api/host-vault');
    if (!resp) return;
    const d = await resp.json();
    input.value = d.value || '';
    if (d.compose_managed) {
      input.readOnly = true;
      if (saveBtn) saveBtn.disabled = true;
      msg.textContent = d.message || '该路径由宿主机 Compose 的 .env 管理';
      msg.style.color = 'var(--warning)';
    } else if (d.source === 'env') {
      msg.textContent = '当前由进程环境变量提供（修改 .env 不会立即覆盖）';
      msg.style.color = 'var(--warning)';
    } else if (d.source === 'file') {
      msg.textContent = '当前来自 ' + (d.env_file || '.env');
    } else {
      msg.textContent = '尚未设置（默认使用 ./buckets）';
    }
  } catch(e) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '加载失败: ' + e;
  }
}

async function saveHostVault() {
  const input = document.getElementById('settings-host-vault');
  const msg = document.getElementById('settings-host-vault-msg');
  if (!input) return;
  const value = input.value.trim();
  msg.textContent = '保存中… / Saving…';
  msg.style.color = 'var(--text-dim)';
  try {
    const resp = await authFetch('/api/host-vault', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({value})
    });
    if (!resp) return;
    const d = await resp.json();
    if (resp.ok) {
      msg.style.color = 'var(--accent)';
      msg.textContent = d.message || ('已保存 → ' + (d.env_file || '.env') + '（需重启容器生效）');
    } else {
      msg.style.color = 'var(--negative)';
      msg.textContent = d.error || '保存失败';
    }
  } catch(e) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '保存失败: ' + e;
  }
}

function setRestartRequired(required, reason) {
  var button = document.getElementById('btn-restart');
  if (!button) return;
  button.classList.toggle('restart-required', !!required);
  button.title = required ? ('需要重启后生效' + (reason ? '：' + reason : '')) : '重启服务';
}

async function syncRestartRequirement() {
  try {
    var response = await authFetch('/api/config');
    if (!response || !response.ok) return;
    var config = await response.json();
    setRestartRequired(!!config.restart_required, 'MCP 鉴权设置已保存');
  } catch (e) { /* 顶栏提示失败不影响主界面 */ }
}

async function restartService() {
  var pending = document.getElementById('btn-restart')?.classList.contains('restart-required');
  var message = pending
    ? '有设置正在等待重启生效。确定现在重启服务吗？连接会短暂中断。'
    : '确定现在重启服务吗？Dashboard 与 MCP 连接会短暂中断。';
  if (!confirm(message)) return;
  try {
    var response = await authFetch('/api/restart', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({confirm: true})
    });
    if (!response) return;
    var result = await readJsonSafe(response);
    if (!response.ok || !result.ok) throw new Error(result.error || '重启请求失败');
    setRestartRequired(false);
    var button = document.getElementById('btn-restart');
    if (button) button.textContent = '重启中…';
    setTimeout(function () { location.reload(); }, 5000);
  } catch (e) { alert('重启失败：' + e.message); }
}

// authFetch: wraps fetch, shows auth overlay on 401
async function authFetch(url, options) {
  let resp = await fetch(url, options);
  // 瞬时网关错误（多见于 Cloudflare 隧道刚重连的几秒窗口）：自动重试一次。
  // 这些后端接口都是幂等的（读取 / upsert），重试安全，能让隧道抖动对用户隐形。
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
    await new Promise(function (r) { setTimeout(r, 1200); });
    try { resp = await fetch(url, options); } catch (e) { /* 保留首个响应 */ }
  }
  if (resp.status === 401) {
    checkAuth();
    return null;
  }
  return resp;
}

// 安全解析 JSON：当响应体为空或不是 JSON（典型是 502/504 网关 HTML 错误页，
// 隧道重连时会出现）时，抛出一句人话错误，而不是浏览器那句晦涩的
// "Unexpected end of JSON input" / iOS Safari 的 "The string did not match the
// expected pattern."。所有设置类接口都应走这里，避免把网关抖动显示成怪异报错。
async function readJsonSafe(resp) {
  var text = await resp.text();
  if (!text || !text.trim()) {
    throw new Error('服务无响应（HTTP ' + resp.status + '），可能是隧道正在重连，请稍后重试');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    var snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    throw new Error('网关/网络错误（HTTP ' + resp.status + '）：' + (snippet || '响应非 JSON') + ' — 请稍后重试');
  }
}

// ========================================

const BASE = location.origin;
let allBuckets = [];
let currentFilter = 'all';
var BUCKET_SORT_MODES = ['score', 'created_desc', 'created_asc'];
var bucketSort = 'score';
try {
  var storedBucketSort = localStorage.getItem('ombreBucketSort');
  if (BUCKET_SORT_MODES.includes(storedBucketSort)) bucketSort = storedBucketSort;
} catch (_) { /* localStorage unavailable: keep the compatible score default */ }
var bucketLoadGeneration = 0;
var selectedBucketIds = new Set();
var developerMode = localStorage.getItem('ombreDeveloperMode') === 'true';

function syncBucketSortControl() {
  var control = document.getElementById('bucket-sort');
  if (control) control.value = bucketSort;
  var note = document.getElementById('bucket-sort-note');
  if (!note) return;
  note.textContent = bucketSort === 'created_desc'
    ? '按首次记录时间倒序；最新记忆在前，未知时间排末尾'
    : bucketSort === 'created_asc'
      ? '按首次记录时间正序；最早记忆在前，未知时间排末尾'
      : '按综合衰减分排列';
}

async function setBucketSort(value) {
  var normalized = BUCKET_SORT_MODES.includes(value) ? value : 'score';
  bucketSort = normalized;
  try { localStorage.setItem('ombreBucketSort', bucketSort); } catch (_) {}
  bucketPage = 1;
  syncBucketSortControl();
  await loadBuckets();
}

syncBucketSortControl();

function setDeveloperMode(enabled) {
  developerMode = !!enabled;
  localStorage.setItem('ombreDeveloperMode', developerMode ? 'true' : 'false');
  document.body.classList.toggle('developer-mode', developerMode);
}
document.addEventListener('DOMContentLoaded', function() {
  var toggle = document.getElementById('developer-mode-toggle');
  if (toggle) toggle.checked = developerMode;
  var sw = document.getElementById('developer-mode-sw');
  if (sw) sw.setAttribute('aria-checked', developerMode ? 'true' : 'false');
  setDeveloperMode(developerMode);
});

function _currentBucketPageItems() {
  var visible = (_curBuckets || []).filter(function(b) { return !b.dont_surface; });
  if (!visible.length) return [];
  var totalPages = Math.ceil(visible.length / BUCKETS_PER_PAGE);
  var page = _normalizeBucketPage(bucketPage, totalPages, 1);
  var startIdx = (page - 1) * BUCKETS_PER_PAGE;
  return visible.slice(startIdx, startIdx + BUCKETS_PER_PAGE);
}

function _currentBucketPageIds() {
  return _currentBucketPageItems().map(function(b) { return b.id; });
}

function syncBucketSelectionUi() {
  var count = document.getElementById('bucket-selected-count');
  if (count) count.textContent = '已选 ' + selectedBucketIds.size;
  document.querySelectorAll('.bucket-select').forEach(function(box) {
    box.checked = selectedBucketIds.has(box.dataset.id);
  });
  var pageIds = _currentBucketPageIds();
  var all = document.getElementById('bucket-select-all');
  if (all) {
    all.checked = !!pageIds.length && pageIds.every(function(id) { return selectedBucketIds.has(id); });
    all.indeterminate = pageIds.some(function(id) { return selectedBucketIds.has(id); }) && !all.checked;
    all.disabled = !pageIds.length;
  }
}

function toggleBucketSelection(id, checked) {
  if (checked) selectedBucketIds.add(id); else selectedBucketIds.delete(id);
  syncBucketSelectionUi();
}

function selectAllCurrentPage(checked) {
  _currentBucketPageIds().forEach(function(id) {
    if (checked) selectedBucketIds.add(id); else selectedBucketIds.delete(id);
  });
  syncBucketSelectionUi();
}

async function runBucketBatch(action) {
  var ids = Array.from(selectedBucketIds);
  if (!ids.length) return alert('请先选择记忆桶。');
  var labels = {forget:'主动遗忘', resolve:'沉底', archive:'归档'};
  if (!confirm('确认对 ' + ids.length + ' 条记忆执行“' + labels[action] + '”？')) return;
  var res = await authFetch('/api/buckets/batch', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids:ids, action:action})});
  if (!res) return;
  var data = await readJsonSafe(res);
  if (!res.ok) return alert(data.error || '批量操作失败');
  if (action === 'forget' && window.ObPet) ObPet.react('forget');
  selectedBucketIds.clear();
  closeDetail();
  await loadBuckets();
}

async function hardDeleteSelectedTests() {
  if (!developerMode) return;
  var byId = {};
  (allBuckets || []).forEach(function(b) { byId[b.id] = b; });
  var ids = Array.from(selectedBucketIds);
  var refused = ids.filter(function(id) { return !byId[id] || !byId[id].erasable_test_data; });
  if (!ids.length) return alert('请先选择测试桶。');
  if (refused.length) { if(window.ObPet) ObPet.react('protect'); return alert('所选内容包含真实记忆或未标记测试来源的桶，已拒绝永久删除。'); }
  var phrase = prompt('这是不可撤销的测试数据清理。请输入 DELETE TEST DATA 继续：');
  if (phrase !== 'DELETE TEST DATA') return;
  var res = await authFetch('/api/developer/buckets/hard-delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids:ids, confirm:phrase, reason:'Dashboard developer cleanup'})});
  if (!res) return;
  var data = await readJsonSafe(res);
  if (!res.ok) return alert(data.error || ('永久删除失败：' + JSON.stringify(data.refused || data.errors)));
  if (window.ObPet) ObPet.react('test_delete');
  selectedBucketIds.clear();
  closeDetail();
  await loadBuckets();
}

function activateDashboardTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    const pending = [];
    document.getElementById('list-view').style.display = target === 'list' ? '' : 'none';
    document.getElementById('breath-view').style.display = target === 'breath' ? '' : 'none';
    document.getElementById('network-view').style.display = target === 'network' ? '' : 'none';
    document.getElementById('plan-view').style.display = target === 'plan' ? '' : 'none';
    document.getElementById('import-view').style.display = target === 'import' ? '' : 'none';
    document.getElementById('faq-view').style.display = target === 'faq' ? '' : 'none';
    document.getElementById('logs-view').style.display = target === 'logs' ? '' : 'none';
    document.getElementById('v3-debug-view').style.display = target === 'v3-debug' ? '' : 'none';
    document.getElementById('settings-view').style.display = target === 'settings' ? '' : 'none';
    document.getElementById('letters-view').style.display = target === 'letters' ? '' : 'none';
    document.getElementById('anchors-view').style.display = target === 'anchors' ? '' : 'none';
    document.getElementById('about-view').style.display = target === 'about' ? '' : 'none';
    if (target !== 'network' && _netRAF) { cancelAnimationFrame(_netRAF); _netRAF = null; }
    if (target === 'network') pending.push(loadNetwork());
    if (target === 'plan') pending.push(loadPlans());
    if (target === 'list') pending.push(loadBuckets());
    if (target === 'import') pending.push(pollImportStatus(), loadImportResults());
    if (target === 'logs') pending.push(loadLogs(), loadOBErrors());
    if (target === 'v3-debug') pending.push(loadV3Debug());
    if (target === 'settings') {
      // 任务D：合并 config + settings 后，切换到「设置」时一次性加载所有面板数据
      pending.push(
        loadSettingsStatus(),
        loadSystemDiagnostics(),
        loadHumanName(),
        loadConfig(),
        refreshEnvConfig(),
        loadGithubStatus(),
        loadSamplingSettings(),
        loadEnvVars(),
        loadHostVault(),
        loadLocalEmbStatus()
      );
      // MCP 面板同步初始化（不依赖异步请求）
      const _mcpOriginEl = document.getElementById('mcp-local-origin');
      if (_mcpOriginEl) _mcpOriginEl.textContent = location.origin;
      renderMcpUrls();
    }
    if (target === 'letters') pending.push(loadLetters());
    if (target === 'anchors') pending.push(loadAnchorsView());
    if (target === 'about') pending.push(loadAbout());
    return Promise.allSettled(pending);
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activateDashboardTab(tab);
  });
});

let searchTimer;
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (q) searchBuckets(q);
    else renderBuckets(filterBuckets(allBuckets));
  }, 300);
});
function doSearch() {
  clearTimeout(searchTimer);
  const q = document.getElementById('search-input').value.trim();
  if (['小鸡','大吉','可恶的人类','chicken'].includes(q.toLowerCase()) && window.ObPet) ObPet.react('secret');
  if (q) searchBuckets(q);
  else renderBuckets(filterBuckets(allBuckets));
}

async function loadBuckets() {
  var generation = ++bucketLoadGeneration;
  var requestedSort = bucketSort;
  try {
    var sortQuery = requestedSort === 'score'
      ? ''
      : '?sort=' + encodeURIComponent(requestedSort);
    const res = await fetch(BASE + '/api/buckets' + sortQuery);
    const data = await res.json();
    if (!res.ok || !Array.isArray(data)) {
      throw new Error((data && data.error) ? data.error : `HTTP ${res.status}`);
    }
    // Rapid sort changes can leave an older request finishing last. Never let
    // that stale response overwrite the currently selected chronological view.
    if (generation !== bucketLoadGeneration || requestedSort !== bucketSort) return;
    var previousIds = new Set((allBuckets || []).map(function(b){return b.id;}));
    var hadPrevious = previousIds.size > 0;
    allBuckets = data;
    if (hadPrevious && data.some(function(b){return b.erasable_test_data && !previousIds.has(b.id);}) && window.ObPet) ObPet.react('test_create');
    var liveIds = new Set(allBuckets.map(function(b) { return b.id; }));
    selectedBucketIds.forEach(function(id) { if (!liveIds.has(id)) selectedBucketIds.delete(id); });
    updateStats();
    buildFilters();
    // 数据刷新不等于用户切换视图：继续应用当前筛选，并保留所在页。
    // 若刷新后页数减少，_paintBuckets 会自动把 bucketPage 收敛到末页。
    renderBuckets(filterBuckets(allBuckets), true);
    if (data.length === 0 && window.ObPet) window.ObPet.react('empty');
  } catch (e) {
    if (generation !== bucketLoadGeneration || requestedSort !== bucketSort) return;
    document.getElementById('bucket-list').innerHTML = '<div class="loading">加载失败: ' + esc(e.message) + '</div>';
    if (window.ObPet) window.ObPet.react('connection_error');
  }
}

function updateStats() {
  const total = allBuckets.length;
  const pinned = allBuckets.filter(b => b.pinned).length;
  const feels = allBuckets.filter(b => b.type === 'feel').length;
  const resolved = allBuckets.filter(b => b.resolved).length;
  const digested = allBuckets.filter(b => b.digested).length;
  document.getElementById('stats').textContent =
    total + ' 桶 · ' + pinned + ' 钉选 · ' + feels + ' feel · ' + resolved + ' 已解决 · ' + digested + ' 已消化';
  updateChick(total);   // 小黄鸡蛋随记忆总数孵化长大
}

function buildFilters() {
  const domains = new Set();
  allBuckets.forEach(b => (b.domain || []).forEach(d => domains.add(d)));
  const filters = document.getElementById('filters');
  const types = [
    { key: 'all', label: '全部' },
    { key: 'pinned', label: '<i data-lucide="pin"></i> 钉选' },
    { key: 'feel', label: '<i data-lucide="droplet"></i> Feel' },
    { key: 'unresolved', label: '<i data-lucide="zap"></i> 未解决' },
    { key: 'digested', label: '<i data-lucide="leaf"></i> 已消化' },
    { key: 'archived', label: '<i data-lucide="archive"></i> 归档' },
  ];
  const typeKeys = types.map(function(t) { return t.key; });
  // domain 筛选可能因最后一个相关桶被编辑而消失；这时才安全退回“全部”。
  if (currentFilter.startsWith('domain:')) {
    if (!domains.has(currentFilter.slice(7))) currentFilter = 'all';
  } else if (!typeKeys.includes(currentFilter)) {
    currentFilter = 'all';
  }
  const visibleDomains = Array.from(domains).slice(0, 10);
  // 排序会改变 domain 的首次出现顺序。即使当前 domain 掉出前 10，
  // 也保留它的活动按钮，而不是悄悄清空用户的筛选。
  var currentDomain = currentFilter.startsWith('domain:') ? currentFilter.slice(7) : '';
  if (currentDomain && !visibleDomains.includes(currentDomain)) {
    if (visibleDomains.length >= 10) visibleDomains[visibleDomains.length - 1] = currentDomain;
    else visibleDomains.push(currentDomain);
  }
  filters.innerHTML = types.map(function(t) {
    var active = t.key === currentFilter;
    return '<button class="filter-btn ' + (active ? 'active' : '') + '" aria-pressed="' + (active ? 'true' : 'false') + '" data-filter="' + escAttr(t.key) + '">' + t.label + '</button>';
  }).join('') + visibleDomains.map(function(d) {
    var key = 'domain:' + d;
    var active = key === currentFilter;
    return '<button class="filter-btn ' + (active ? 'active' : '') + '" aria-pressed="' + (active ? 'true' : 'false') + '" data-filter="' + escAttr(key) + '">' + esc(d) + '</button>';
  }).join('');

  // buildFilters 会在每次数据刷新后运行；覆盖处理器，避免重复累积监听器。
  filters.onclick = function(e) {
    var btn = e.target.closest('.filter-btn');
    if (!btn) return;
    filters.querySelectorAll('.filter-btn').forEach(function(b) {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    currentFilter = btn.dataset.filter;
    renderBuckets(filterBuckets(allBuckets));
  };
}

function filterBuckets(buckets) {
  if (currentFilter === 'all') return buckets;
  if (currentFilter === 'pinned') return buckets.filter(function(b) { return b.pinned; });
  if (currentFilter === 'feel') return buckets.filter(function(b) { return b.type === 'feel'; });
  if (currentFilter === 'unresolved') return buckets.filter(function(b) { return !b.resolved && b.type !== 'permanent' && !b.pinned; });
  if (currentFilter === 'digested') return buckets.filter(function(b) { return b.digested; });
  if (currentFilter === 'archived') return buckets.filter(function(b) { return b.type === 'archived' || b.score < 0.3; });
  if (currentFilter.startsWith('domain:')) {
    var d = currentFilter.slice(7);
    return buckets.filter(function(b) { return (b.domain || []).includes(d); });
  }
  return buckets;
}

// 翻页状态：用户主动切换筛选/搜索时回到第 1 页；后台刷新可显式保留当前页。
var bucketPage = 1;
var _curBuckets = [];
var BUCKETS_PER_PAGE = 10;

function renderBuckets(buckets, preservePage) {
  _curBuckets = buckets || [];
  if (!preservePage) bucketPage = 1;
  _paintBuckets();
}

function _normalizeBucketPage(value, totalPages, fallbackPage) {
  var maxPage = Number(totalPages);
  maxPage = Number.isFinite(maxPage) && maxPage >= 1 ? Math.trunc(maxPage) : 1;
  var fallback = Number(fallbackPage);
  fallback = Number.isFinite(fallback) ? Math.trunc(fallback) : 1;
  fallback = Math.min(maxPage, Math.max(1, fallback));
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  var parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maxPage, Math.max(1, Math.trunc(parsed)));
}

function _visibleBucketTotalPages() {
  var visibleCount = (_curBuckets || []).filter(function(b) { return !b.dont_surface; }).length;
  return Math.max(1, Math.ceil(visibleCount / BUCKETS_PER_PAGE));
}

function gotoBucketPage(n) {
  bucketPage = _normalizeBucketPage(n, _visibleBucketTotalPages(), bucketPage);
  _paintBuckets();
  var list = document.getElementById('bucket-list');
  if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function jumpToBucketPage() {
  var input = document.getElementById('bucket-page-input');
  if (!input) return;
  gotoBucketPage(input.value);
}

function _bucketPagerHtml(total, totalPages) {
  if (totalPages <= 1) return '';
  return '<nav class="bucket-pager" aria-label="记忆桶分页">' +
    '<button type="button" class="pager-btn" aria-label="跳到第一页"' + (bucketPage <= 1 ? ' disabled' : '') + ' data-ob-click="gotoBucketPage%281%29">« 首页</button>' +
    '<button type="button" class="pager-btn" aria-label="上一页"' + (bucketPage <= 1 ? ' disabled' : '') + ' data-ob-action="bucket-page" data-page="' + (bucketPage - 1) + '">‹ 上一页</button>' +
    '<span class="pager-info" role="status" aria-live="polite">' + bucketPage + ' / ' + totalPages + ' 页 · 共 ' + total + '</span>' +
    '<button type="button" class="pager-btn" aria-label="下一页"' + (bucketPage >= totalPages ? ' disabled' : '') + ' data-ob-action="bucket-page" data-page="' + (bucketPage + 1) + '">下一页 ›</button>' +
    '<button type="button" class="pager-btn" aria-label="跳到最后一页"' + (bucketPage >= totalPages ? ' disabled' : '') + ' data-ob-action="bucket-page" data-page="' + totalPages + '">末页 »</button>' +
    '<form class="pager-jump" data-ob-submit="event.preventDefault%28%29%3BjumpToBucketPage%28%29">' +
      '<label for="bucket-page-input">第</label>' +
      '<input class="pager-input" id="bucket-page-input" type="number" inputmode="numeric" min="1" max="' + totalPages + '" step="1" value="' + bucketPage + '" aria-label="输入页码">' +
      '<span>页</span>' +
      '<button type="submit" class="pager-btn" aria-label="跳转到输入页码">跳转</button>' +
    '</form>' +
  '</nav>';
}

function _paintBuckets() {
  var list = document.getElementById('bucket-list');
  // iter 1.9 C: 把已主动遗忘的桶单独折叠到下方区域，主列表只显示活跃的
  // Split forgotten ones into the dedicated <details>; the main list stays clean.
  var forgotten = _curBuckets.filter(function(b) { return b.dont_surface; });
  var visible = _curBuckets.filter(function(b) { return !b.dont_surface; });
  renderForgottenGroup(forgotten);
  if (!visible.length) {
    bucketPage = 1;
    list.innerHTML = '<div class="loading">没有记忆桶 / No buckets</div>';
    syncBucketSelectionUi();
    return;
  }
  // 分页：每页 BUCKETS_PER_PAGE 个，底部翻页
  var totalPages = Math.ceil(visible.length / BUCKETS_PER_PAGE);
  bucketPage = _normalizeBucketPage(bucketPage, totalPages, 1);
  var pageItems = _currentBucketPageItems();
  list.innerHTML = pageItems.map(function(b) {
    // iter 1.8: dont_surface = 主动遗忘（仍在磁盘） / first_of_kind = 首次出现的标签组合
    // 图标：feel→计算表情、letter→信封、pinned→可发光的钉、其余沿用原逻辑
    var iconCls = 'icon', iconHtml;
    if (b.dont_surface)        iconHtml = '<i data-lucide="eye-off"></i>';
    else if (b.pinned)       { iconHtml = '<i data-lucide="pin"></i>'; iconCls = 'icon pin-ic'; }
    else if (b.type === 'feel')   iconHtml = feelFace(b.valence, b.arousal);
    else if (b.type === 'letter') iconHtml = '<i data-lucide="mail"></i>';
    else if (b.digested)     iconHtml = '<i data-lucide="leaf"></i>';
    else if (b.resolved)     iconHtml = '<i data-lucide="moon"></i>';
    else                     iconHtml = '<i data-lucide="message-circle"></i>';
    var firstBadge = b.first_of_kind ? ' <i data-lucide="sparkles" title="首次出现" style="width:12px;height:12px;color:var(--accent);vertical-align:-1px;"></i>' : '';
    var importedBadge = b.imported ? ' <span title="由对话导入" style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 5px;white-space:nowrap;">被导入</span>' : '';
    var vPos = Math.round(b.valence * 100);
    var modelV = b.model_valence != null ? ' → V' + b.model_valence.toFixed(1) : '';
    var activityTime = firstValidBucketTime(
      b.last_active_epoch_ms, b.last_active, b.created_epoch_ms, b.created
    );
    var chronologicalSort = bucketSort === 'created_desc' || bucketSort === 'created_asc';
    var shownTime = chronologicalSort
      ? firstValidBucketTime(b.created_epoch_ms, b.created)
      : activityTime;
    var timeLabel = chronologicalSort
      ? (shownTime ? '创建 ' + formatCompactBucketTime(shownTime) : '创建时间未知')
      : (shownTime ? '活跃 ' + formatTimeAgo(shownTime) : '活跃时间未知');
    var timeTitle = chronologicalSort
      ? (shownTime ? '首次记录时间：' + formatExactBucketTime(shownTime) : '首次记录时间未知')
      : (shownTime ? '最近活跃时间：' + formatExactBucketTime(shownTime) : '最近活跃时间未知');
    // 久未浮现（>45 天且非钉选/锚点/已遗忘）→ 稀疏虚线，视觉上「模糊、遥远」
    var stale = !b.pinned && !b.anchor && !b.dont_surface && daysSince(activityTime) >= 45;
    var rowCls = 'bucket-row' + (stale ? ' faded' : '');
    var inlineStyle = b.dont_surface ? 'opacity:0.45;' : '';
    var rowClick = 'data-ob-click="showDetail%28this.dataset.id%29"';
    var domainHtml = (b.domain || []).length
      ? '<span class="domain-pill">' + esc((b.domain || []).join(', ')) + '</span>'
      : '';
    var emotionHtml = '<span class="emotion" style="display:inline-flex;align-items:center;gap:3px;"><span class="v-bar"><span class="v-dot" style="left:' + vPos + '%"></span></span>' + modelV + '</span>';
    return '<div class="' + rowCls + '" data-id="' + escAttr(b.id) + '" ' + rowClick + ' style="cursor:pointer;' + inlineStyle + '">' +
      '<div class="bucket-row-top">' +
        '<input class="bucket-select" type="checkbox" data-id="' + escAttr(b.id) + '"' + (selectedBucketIds.has(b.id) ? ' checked' : '') + ' data-ob-click="event.stopPropagation%28%29" data-ob-change="toggleBucketSelection%28this.dataset.id%2Cthis.checked%29">' +
        '<span class="' + iconCls + '">' + iconHtml + '</span>' +
        '<span class="name" title="' + escAttr(b.name) + '">' + esc(b.name) + firstBadge + importedBadge + '</span>' +
        '<div class="bucket-row-tags">' +
          domainHtml +
          emotionHtml +
          '<span class="score">' + (b.score != null ? b.score.toFixed(2) : '—') + '</span>' +
        '</div>' +
        '<span class="time" title="' + escAttr(timeTitle) + '">' + esc(timeLabel) + '</span>' +
      '</div>' +
      '<div class="bucket-row-bottom"><span class="preview">' + esc(b.content_preview) + '</span></div>' +
    '</div>';
  }).join('') + _bucketPagerHtml(visible.length, totalPages);
  if (window.lucide) lucide.createIcons();
  syncBucketSelectionUi();
}

// 本地匹配：桶名 / 预览 / 域 / 标签支持「子串」+「模糊（子序列）」，桶 id 支持子串精确定位。
// 即时可得、离线可用；桶名匹配优先排在最前，正好满足「直接搜桶名」。
function _localBucketMatches(query) {
  var q = query.trim().toLowerCase();
  if (!q) return [];
  function sub(text) { return text && String(text).toLowerCase().indexOf(q) !== -1; }
  function fuzzy(text) {
    if (!text) return false;
    var t = String(text).toLowerCase();
    if (t.indexOf(q) !== -1) return true;           // 子串直接命中
    var i = 0;                                        // 子序列：q 的字符按序出现在 t 中
    for (var j = 0; j < t.length && i < q.length; j++) { if (t[j] === q[i]) i++; }
    return i === q.length;
  }
  var name = [], other = [];
  (allBuckets || []).forEach(function(b) {
    if (fuzzy(b.name)) { name.push(b); return; }      // 桶名命中优先
    if (sub(b.id) || fuzzy(b.content_preview) ||
        fuzzy((b.domain || []).join(' ')) || fuzzy((b.tags || []).join(' '))) other.push(b);
  });
  return name.concat(other);                          // 桶名匹配排最前
}

function normalizeMeaningItems(value) {
  var values = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? [value] : []);
  return values.map(function(item) {
    return typeof item === 'string' ? item.trim() : '';
  }).filter(function(item) { return item.length > 0; });
}

function renderMeaningHtml(value) {
  var items = normalizeMeaningItems(value);
  if (!items.length) return '';
  return '<section class="meaning-block" data-field="meaning" aria-label="Meaning / 为什么值得被想起">' +
    '<div class="meaning-block-label">MEANING · 为什么值得被想起</div>' +
    items.map(function(item) {
      return '<blockquote class="meaning-quote">❝ ' + esc(item) + ' ❞</blockquote>';
    }).join('') +
  '</section>';
}

async function searchBuckets(query) {
  var seen = {}, merged = [];
  _localBucketMatches(query).forEach(function(b) { if (!seen[b.id]) { seen[b.id] = 1; merged.push(b); } });
  // 服务端语义搜索：补充本地字面没匹配到、但语义相关的桶（向量化未开启时会失败，自动退化为纯本地）
  try {
    var res = await fetch(BASE + '/api/search?q=' + encodeURIComponent(query));
    if (res.ok) {
      var results = await res.json();
      if (Array.isArray(results)) results.forEach(function(b) { if (!seen[b.id]) { seen[b.id] = 1; merged.push(b); } });
    }
  } catch (e) { /* 离线 / 无向量化：退化为纯本地字面 + 模糊匹配 */ }
  renderBuckets(merged);
}

let detailLoadGeneration = 0;
async function showDetail(id) {
  const generation = ++detailLoadGeneration;
  var panel = document.getElementById('detail-panel');
  var content = document.getElementById('detail-content');
  content.innerHTML = '<div class="loading">加载中… / Loading…</div>';
  panel.classList.add('open');

  try {
    var res = await fetch(BASE + '/api/bucket/' + encodeURIComponent(id));
    var b = await readJsonSafe(res);
    if (generation !== detailLoadGeneration) return false;
    if (!res.ok) throw new Error((b && b.error) || ('HTTP ' + res.status));
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('记忆详情响应无效 / Invalid bucket detail response');
    var meta = b.metadata || {};
    // content 是可无损写回的原始 Markdown；display_content 仅供详情展示。
    var displayContent = typeof b.display_content === 'string' ? b.display_content : (b.content || '');
    var safeValence = safeNumber(meta.valence, 0.5, 0, 1);
    var safeArousal = safeNumber(meta.arousal, 0.3, 0, 1);
    var safeModelValence = meta.model_valence == null
      ? null
      : safeNumber(meta.model_valence, 0.5, 0, 1);
    var safeImportance = Math.round(safeNumber(meta.importance, 5, 1, 10));
    var safeActivationCount = safeNumber(meta.activation_count, 0, 0);
    // letter → 翻信纸展开动画；anchor → 引力线背景（坐标系质感）
    panel.classList.toggle('letter-mode', meta.type === 'letter');
    panel.classList.toggle('anchor-mode', !!meta.anchor);
    // iter 1.8: why_remembered = 这条为什么被记得（展示不计分）
    var whyHtml = meta.why_remembered ? ('<div style="margin:8px 0 16px;padding:10px 14px;border-left:3px solid var(--accent);background:var(--surface-solid);font-style:italic;color:var(--accent);font-family:\'Cormorant Garamond\',\'Noto Serif SC\',serif;line-height:1.7;">❝ ' + esc(meta.why_remembered) + ' ❞</div>') : '';
    // meaning 是可累积的体验锚点；兼容早期手写桶中的单字符串格式。
    var meaningHtml = renderMeaningHtml(meta.meaning);
    var firstBadge = meta.first_of_kind ? '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--accent);margin-left:8px;"><i data-lucide="sparkles" style="width:12px;height:12px;"></i>首次出现</span>' : '';
    var weightHtml = (meta.type === 'plan' && meta.weight != null) ? ('<div class="field"><label>承诺重量</label><span style="display:inline-block;width:80px;height:6px;background:var(--border);border-radius:3px;vertical-align:middle;overflow:hidden;"><span style="display:block;width:' + Math.round(meta.weight*100) + '%;height:100%;background:var(--accent);"></span></span> ' + (meta.weight*100).toFixed(0) + '% · ' + weightAnchorLabel(meta.weight) + '</div>') : '';
    // iter 1.9 D3: triggered_by 渲染成可跳转链接
    var triggerHtml = meta.triggered_by ? ('<div class="field"><label>源 bucket</label><a href="#" data-bucket-id="' + escAttr(meta.triggered_by) + '" style="color:var(--accent);text-decoration:underline;font-size:11px;" data-ob-click="showDetail%28this.dataset.bucketId%29%3Breturn%20false">' + esc(meta.triggered_by) + ' →</a></div>') : '';
    // iter 1.9 D2: 反向链——这条触发了哪些 feel
    var triggeredFeelsHtml = '';
    if (b.triggered_feels && b.triggered_feels.length) {
      triggeredFeelsHtml = '<div style="margin:14px 0;padding:10px 14px;border-left:3px solid var(--accent);background:var(--surface-solid);">' +
        '<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">这条触发了 ' + b.triggered_feels.length + ' 条 feel：</div>' +
        '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;">' +
        b.triggered_feels.map(function(f) {
          return '<li><a href="#" data-bucket-id="' + escAttr(f.id) + '" style="color:var(--accent);text-decoration:none;" data-ob-click="showDetail%28this.dataset.bucketId%29%3Breturn%20false">' + esc(f.name) + '</a></li>';
        }).join('') +
        '</ul></div>';
    }
    content.innerHTML =
      '<h2>' + esc(meta.title || meta.name || id) + firstBadge + '</h2>' +
      whyHtml +
      meaningHtml +
      '<div class="detail-meta">' +
        '<div class="field"><label>ID</label>' + esc(id) + '</div>' +
        '<div class="field"><label>类型 / Type</label>' + esc(meta.type || 'dynamic') + '</div>' +
        '<div class="field"><label>域 / Domain</label>' + esc((meta.domain || []).join(', ')) + '</div>' +
        '<div class="field"><label>标签 / Tags</label>' + esc((meta.tags || []).join(', ')) + '</div>' +
        '<div class="field"><label>事件效价 / Valence</label>V' + safeValence.toFixed(2) + '</div>' +
        '<div class="field"><label>唤醒度 / Arousal</label>A' + safeArousal.toFixed(2) + '</div>' +
        '<div class="field"><label>模型视角 / Model view</label>' + (safeModelValence != null ? 'V' + safeModelValence.toFixed(2) : '—') + '</div>' +
        '<div class="field"><label>重要度 / Importance</label>' + safeImportance + '/10</div>' +
        '<div class="field"><label>活跃度分 / Activity score</label>' + (b.score != null ? b.score.toFixed(4) : '—') + '</div>' +
        '<div class="field"><label>激活次数 / Activations</label>' + safeActivationCount + '</div>' +
        '<div class="field"><label>已解决 / Resolved</label>' + (meta.resolved ? _SV.ok : '—') + '</div>' +
        '<div class="field"><label>已消化 / Digested</label>' + (meta.digested ? _SV.ok : '—') + '</div>' +
        '<div class="field"><label>钉选 / Pinned</label>' + (meta.pinned ? _SV.ok : '—') + '</div>' +
        '<div class="field"><label>导入来源 / Imported</label>' + (meta.imported || meta.source_tool === 'import' ? '被导入' : '—') + '</div>' +
        '<div class="field"><label>Anchor</label>' + (meta.anchor ? _SV.anchor+' 坐标系 / anchor' : '—') + '</div>' +
        '<div class="field"><label>创建 / Created</label>' + esc(meta.created || '—') + '</div>' +
        '<div class="field"><label>最后活跃 / Last active</label>' + esc(meta.last_active || '—') + '</div>' +
        weightHtml +
        triggerHtml +
      '</div>' +
      triggeredFeelsHtml +
      '<div class="detail-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;">' +
        '<button data-bucket-id="' + escAttr(id) + '" class="icon-btn" data-ob-click="bucketPin%28this.dataset.bucketId%29">' + (meta.pinned ? '<i data-lucide="pin-off"></i> 取消钉选' : '<i data-lucide="pin"></i> 钉选') + '</button>' +
        '<button data-bucket-id="' + escAttr(id) + '" class="icon-btn" title="anchor = 坐标系，不主动浮现，硬上限 24" data-ob-click="bucketAnchor%28this.dataset.bucketId%29">' + (meta.anchor ? '<i data-lucide="anchor"></i> 释放 anchor' : '<i data-lucide="anchor"></i> 设为 anchor') + '</button>' +
        '<button data-bucket-id="' + escAttr(id) + '" class="icon-btn" data-ob-click="bucketResolve%28this.dataset.bucketId%29">' + (meta.resolved ? '<i data-lucide="rotate-ccw"></i> 取消已解决' : '<i data-lucide="check"></i> 标记已解决') + '</button>' +
        '<button data-bucket-id="' + escAttr(id) + '" class="icon-btn" data-ob-click="bucketForget%28this.dataset.bucketId%29">' + (meta.dont_surface ? '<i data-lucide="eye"></i> 重新允许浮现' : '<i data-lucide="eye-off"></i> 主动遗忘') + '</button>' +
        '<button data-bucket-id="' + escAttr(id) + '" class="icon-btn" data-ob-click="bucketArchive%28this.dataset.bucketId%29"><i data-lucide="archive"></i> 归档</button>' +
        '<button data-bucket-id="' + escAttr(id) + '" class="icon-btn" style="color:#b85c3c;" data-ob-click="bucketDelete%28this.dataset.bucketId%29"><i data-lucide="trash-2"></i> 删除到档案</button>' +
      '</div>' +
      '<div class="detail-content">' + esc(displayContent) + '</div>' +
      renderEditForm(id, Object.assign({}, meta, {_content_for_edit: b.content}));
    return true;
  } catch (e) {
    if (generation !== detailLoadGeneration) return false;
    content.innerHTML = '<div class="loading">加载失败: ' + esc(e.message) + '</div>';
    return false;
  }
}

async function bucketPin(id) {
  try {
    var current = (allBuckets || []).find(function(b) { return b.id === id; });
    var body = {};
    if (current && current.pinned) {
      var rawImportance = prompt('解除钉选后，请设定新的 importance（1-10）：', '5');
      if (rawImportance === null) return;
      var nextImportance = Number(rawImportance);
      if (!Number.isInteger(nextImportance) || nextImportance < 1 || nextImportance > 10) {
        alert('importance 必须是 1-10 的整数。');
        return;
      }
      body.importance = nextImportance;
    }
    var res = await fetch(BASE + '/api/bucket/' + encodeURIComponent(id) + '/pin', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    await showDetail(id);
    await loadBuckets();
  } catch (e) { alert('钉选切换失败 / Pin toggle failed: ' + e.message); }
}

// iter 2.0: anchor 切换 / anchor toggle
async function bucketAnchor(id) {
  var body = await toggleAnchor(id);  // toggle = no value
  if (body && body.ok) {
    await showDetail(id);
  }
}

// iter 1.8: 主动遗忘切换 / voluntary forget toggle
//   POST /api/bucket/{id}/forget 反转 dont_surface。桁仍在磁盘上，
//   只不再在无参 breath() 中被主动推出。搜索仍能找到。
async function bucketForget(id) {
  try {
    var res = await fetch(BASE + '/api/bucket/' + encodeURIComponent(id) + '/forget', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    if (window.ObPet) ObPet.react('forget');
    await showDetail(id);
    loadBuckets();
  } catch (e) { alert('遗忘切换失败 / Forget toggle failed: ' + e.message); }
}

// iter 1.9 C: 渲染折叠区 + 批量允许浮现
function renderForgottenGroup(forgotten) {
  var box = document.getElementById('forgotten-group');
  var listEl = document.getElementById('forgotten-list');
  var countEl = document.getElementById('forgotten-count');
  if (!box) return;
  if (!forgotten.length) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  countEl.textContent = forgotten.length;
  listEl.innerHTML = forgotten.map(function(b) {
    return '<div class="bucket-row" style="opacity:0.6;">' +
      '<span class="icon"><i data-lucide="eye-off"></i></span>' +
      '<span class="name" data-bucket-id="' + escAttr(b.id) + '" style="cursor:pointer;" data-ob-click="showDetail%28this.dataset.bucketId%29">' + esc(b.name) + '</span>' +
      '<span class="domain">' + esc((b.domain || []).join(', ')) + '</span>' +
      '<span class="time">' + esc(formatTimeAgo(b.last_active || b.created)) + '</span>' +
      '<button data-bucket-id="' + escAttr(b.id) + '" title="允许浮现" style="font-size:11px;padding:2px 6px;margin-left:auto;display:inline-flex;align-items:center;" data-ob-click="bucketAllowOne%28this.dataset.bucketId%29"><i data-lucide="eye" style="width:12px;height:12px;"></i></button>' +
      '</div>';
  }).join('');
  if (window.lucide) lucide.createIcons();
}

async function bucketAllowOne(id) {
  try {
    var res = await fetch(BASE + '/api/buckets/forget', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ ids: [id], dont_surface: false }),
    });
    if (!res.ok) throw new Error(await res.text());
    loadBuckets();
  } catch (e) { alert('恢复失败 / Restore failed: ' + e.message); }
}

async function bucketsForgetAllow() {
  var ids = (allBuckets || []).filter(function(b) { return b.dont_surface; }).map(function(b) { return b.id; });
  if (!ids.length) return;
  if (!confirm('把这 ' + ids.length + ' 条全部恢复为允许浮现？ / Restore surfacing for all ' + ids.length + ' item(s)?')) return;
  try {
    var res = await fetch(BASE + '/api/buckets/forget', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ ids: ids, dont_surface: false }),
    });
    if (!res.ok) throw new Error(await res.text());
    loadBuckets();
  } catch (e) { alert('批量恢复失败 / Bulk restore failed: ' + e.message); }
}

async function bucketResolve(id) {
  try {
    var res = await fetch(BASE + '/api/bucket/' + encodeURIComponent(id) + '/resolve', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    var d = await res.json();
    if (d.message) alert(d.message);
    await showDetail(id);
    loadBuckets();
  } catch (e) { alert('resolve 切换失败: ' + e.message); }
}

async function bucketArchive(id) {
  if (!confirm('确认归档此桶？归档后将从浮现/搜索中隐藏，但文件仍保留在 archive/ 目录。\n\nArchive this bucket? It will be hidden from surfacing/search, but the file stays in archive/.')) return;
  try {
    var res = await fetch(BASE + '/api/bucket/' + encodeURIComponent(id) + '/archive', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    closeDetail();
    loadBuckets();
  } catch (e) { alert('归档失败: ' + e.message); }
}

async function bucketDelete(id) {
  if (!confirm('这会把此记忆桶移入删除档案，并从日常界面隐藏；文件仍保留在 archive/ 中。继续？\n\nThis moves the bucket to the delete archive and hides it from everyday views; the file stays in archive/. Continue?')) return;
  try {
    var res = await fetch(BASE + '/api/bucket/' + encodeURIComponent(id) + '?confirm=true', { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    closeDetail();
    // 「放下」：让这条记忆轻轻消散，而不是直接消失
    var sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    var row = document.querySelector('.bucket-row[data-id="' + sel + '"]');
    if (row) { row.classList.add('dissolving'); setTimeout(loadBuckets, 600); }
    else { loadBuckets(); }
  } catch (e) { alert('删除失败: ' + e.message); }
}

function closeDetail() {
  detailLoadGeneration++;
  document.getElementById('detail-panel').classList.remove('open', 'letter-mode', 'anchor-mode');
}

// ============================================================
// 记忆网络图改造 patch
// 替换原来的 loadNetwork() 和 drawConceptNetwork()
// 新增：深度滑块、点击展开邻居、默认只显示高频节点
// ============================================================

// –– 全局状态 ––
var networkData = null;
var _netRAF = null;
var _netListenersAttached = false;
var _netRotAngle = 0;
var networkState = {
  focusNode: null,      // 当前聚焦的节点 id，null = 全局视图
  depth: 2,             // 展开深度
  visibleNodes: null,   // 当前渲染的节点 id Set
  positions: {},        // 节点坐标缓存
  isDragging: false,
  dragStart: null,
  panOffset: { x: 0, y: 0 },
  scale: 1,
};

// –– 替换 loadNetwork ––
async function loadNetwork() {
  if (_netRAF) { cancelAnimationFrame(_netRAF); _netRAF = null; }
  var canvas = document.getElementById('network-canvas');
  var termEl = document.getElementById('network-terminal');
  canvas.classList.remove('star-active');
  if (termEl) termEl.classList.remove('star-active');

  var ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * window.devicePixelRatio;
  canvas.height = canvas.offsetHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  var W = canvas.offsetWidth, H = canvas.offsetHeight;

  ctx.fillStyle = '#C7C9BC';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#5B5D4F';
  ctx.font = "14px 'Share Tech Mono', monospace";
  ctx.textAlign = 'center';
  ctx.fillText('LOADING MEMORY NET…', W / 2, H / 2);
  setNetTerminal('SCANNING · 正在读取记忆网络');

  try {
    var modeSel = document.getElementById('network-mode');
    var mode = modeSel ? modeSel.value : 'concept';
    var res = await fetch(BASE + '/api/network?mode=' + encodeURIComponent(mode));
    networkData = await res.json();

    if (mode === 'embedding') {
      drawBucketNetwork(ctx, W, H, networkData);
    } else {
      initConceptNetwork(canvas, ctx, W, H, networkData);
    }
    var _n = (networkData.nodes || []).length, _e = (networkData.edges || networkData.links || []).length;
    setNetTerminal('ONLINE · ' + _n + ' nodes / ' + _e + ' links · mode=' + mode);
  } catch (e) {
    ctx.fillStyle = '#5B5D4F';
    ctx.textAlign = 'center';
    ctx.fillText('LOAD FAILED: ' + e.message, W / 2, H / 2 + 24);
    setNetTerminal('ERROR · ' + e.message);
  }
}

// 屏内 mini-terminal 滚动日志行
function setNetTerminal(msg) {
  var el = document.getElementById('network-terminal');
  if (el) el.textContent = msg;
}

// –– 初始化（绑定交互，启动星空动画） ––
function initConceptNetwork(canvas, ctx, W, H, data) {
  injectNetworkControls();
  buildAdjacency(data);

  var nodes = data.nodes || [];
  var sorted = nodes.slice().sort(function (a, b) { return (b.freq || 1) - (a.freq || 1); });
  var defaultVisible = new Set(sorted.slice(0, 30).map(function (n) { return n.id; }));

  networkState.focusNode    = null;
  networkState.visibleNodes = defaultVisible;
  networkState.positions    = {};
  networkState.panOffset    = { x: 0, y: 0 };
  networkState.scale        = 1;
  networkState.needsLayout  = true;
  _netRotAngle              = 0;

  // 切换成工程网格星图外观
  canvas.classList.add('star-active');
  var termEl = document.getElementById('network-terminal');
  if (termEl) termEl.classList.add('star-active');

  animateConceptNetwork(canvas, ctx, W, H, data);

  // 事件只注册一次（切 tab 不重复绑定）
  if (!_netListenersAttached) {
    _netListenersAttached = true;

    canvas.addEventListener('click', function (e) {
      if (!networkData) return;
      var d = networkData;
      var sortedAll = (d.nodes || []).slice().sort(function (a, b) { return (b.freq || 1) - (a.freq || 1); });
      var rect = canvas.getBoundingClientRect();
      var hit  = hitTest(e.clientX - rect.left, e.clientY - rect.top, W, H);
      if (hit) {
        if (networkState.focusNode === hit) {
          networkState.focusNode    = null;
          networkState.visibleNodes = new Set(sortedAll.slice(0, 30).map(function (n) { return n.id; }));
        } else {
          networkState.focusNode    = hit;
          networkState.visibleNodes = getNeighbors(hit, networkState.depth, d);
        }
        networkState.positions   = {};
        networkState.needsLayout = true;
      }
    });

    var bubble = ensureNetworkBubble();
    canvas.addEventListener('mousemove', function (e) {
      if (!networkData) return;
      var d   = networkData;
      var rect = canvas.getBoundingClientRect();
      var hit  = hitTest(e.clientX - rect.left, e.clientY - rect.top, W, H);
      networkState.hoverNode = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      if (hit) {
        var n = (d.nodes || []).find(function (x) { return x.id === hit; });
        if (n) {
          var deg     = (d._adj && d._adj[hit] ? d._adj[hit].length : 0);
          var kindTxt = n.kind === 'tag' ? '#tag' : (n.kind === 'mixed' ? '双链+tag' : '[[双链]]');
          bubble.innerHTML =
            '<b>' + esc((n.kind === 'tag' ? '#' : '') + (n.label || n.id)) + '</b>' +
            (n.anchor ? ' <span style="color:var(--accent)">' + _SV.anchor + ' anchor</span>' : '') +
            '<br>' + kindTxt + ' · freq ' + Number(n.freq || 1) + ' · 关联 ' + Number(deg) + ' 个';
          bubble.style.left    = (e.clientX + 16) + 'px';
          bubble.style.top     = (e.clientY + 16) + 'px';
          bubble.style.opacity = '1';
        }
      } else {
        bubble.style.opacity = '0';
      }
    });
    canvas.addEventListener('mouseleave', function () {
      bubble.style.opacity   = '0';
      networkState.hoverNode = null;
      canvas.style.cursor    = 'default';
    });
  }
}

// 屏内发光气泡（hover 详情），跟随光标
function ensureNetworkBubble() {
  var b = document.getElementById('network-hover-bubble');
  if (b) return b;
  b = document.createElement('div');
  b.id = 'network-hover-bubble';
  b.style.cssText = [
    'position:fixed', 'z-index:300', 'pointer-events:none', 'opacity:0',
    'transition:opacity .15s ease', 'max-width:260px',
    'padding:9px 13px', 'border-radius:10px',
    'background:var(--surface)', 'color:var(--text)',
    "font-family:'Share Tech Mono',monospace", 'font-size:11px', 'line-height:1.65',
    'box-shadow:4px 4px 14px var(--shadow-dark), -2px -2px 8px var(--shadow-light), inset 0 1px 0 rgba(255,255,255,0.6)'
  ].join(';');
  document.body.appendChild(b);
  return b;
}

// –– 构建邻接表 ––
function buildAdjacency(data) {
  data._adj = {};
  (data.nodes || []).forEach(function (n) { data._adj[n.id] = []; });
  (data.edges || []).forEach(function (e) {
    if (data._adj[e.source]) data._adj[e.source].push(e.target);
    if (data._adj[e.target]) data._adj[e.target].push(e.source);
  });
}

// –– BFS 取 depth 层邻居 ––
function getNeighbors(startId, depth, data) {
  var visited = new Set([startId]);
  var frontier = [startId];
  for (var d = 0; d < depth; d++) {
    var next = [];
    frontier.forEach(function (id) {
      (data._adj[id] || []).forEach(function (nb) {
        if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
      });
    });
    frontier = next;
    if (!frontier.length) break;
  }
  return visited;
}

// –– 碰撞检测（返回被点击的节点 id 或 null） ––
function hitTest(mx, my, W, H) {
  if (!networkData) return null;
  // 反向旋转鼠标坐标，对应到未旋转的节点坐标系
  var cx  = W / 2, cy = H / 2;
  var cos = Math.cos(-_netRotAngle), sin = Math.sin(-_netRotAngle);
  var rx  = cx + (mx - cx) * cos - (my - cy) * sin;
  var ry  = cy + (mx - cx) * sin + (my - cy) * cos;
  var nodes = networkData.nodes || [];
  var hit = null;
  nodes.forEach(function (n) {
    if (!networkState.visibleNodes.has(n.id)) return;
    var p = networkState.positions[n.id];
    if (!p) return;
    var r  = Math.max(4, Math.min(14, 2 + Math.sqrt(n.freq || 1) * 2.5)) + 5;
    var dx = rx - p.x, dy = ry - p.y;
    if (dx * dx + dy * dy < r * r) hit = n.id;
  });
  return hit;
}

// –– 布局计算（力导向，不绘制） ––
function _computeConceptLayout(W, H, data) {
  var visible  = networkState.visibleNodes;
  var focusId  = networkState.focusNode;
  var allNodes = data.nodes || [];
  var allEdges = data.edges || [];
  var nodes    = allNodes.filter(function (n) { return visible.has(n.id); });
  var edges    = allEdges.filter(function (e) { return visible.has(e.source) && visible.has(e.target); });
  var positions = networkState.positions;
  var cx = W / 2, cy = H / 2;

  if (focusId && positions[focusId]) {
    positions[focusId] = { x: cx, y: cy };
  }
  nodes.forEach(function (n, i) {
    if (positions[n.id]) return;
    var a = (i / nodes.length) * Math.PI * 2;
    var r = Math.min(W, H) * 0.32;
    positions[n.id] = {
      x: cx + Math.cos(a) * r + (Math.random() - 0.5) * 50,
      y: cy + Math.sin(a) * r + (Math.random() - 0.5) * 50,
    };
  });
  var iters = Math.min(120, 30 + nodes.length * 2);
  for (var iter = 0; iter < iters; iter++) {
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var pa = positions[nodes[i].id], pb = positions[nodes[j].id];
        var dx = pb.x - pa.x, dy = pb.y - pa.y;
        var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        var force = 1400 / (dist * dist);
        dx = (dx / dist) * force; dy = (dy / dist) * force;
        pa.x -= dx; pa.y -= dy; pb.x += dx; pb.y += dy;
      }
    }
    edges.forEach(function (e) {
      var pa = positions[e.source], pb = positions[e.target];
      if (!pa || !pb) return;
      var dx = pb.x - pa.x, dy = pb.y - pa.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var pull = Math.min(1, (e.weight || 1) / 4);
      var ideal = nodes.length < 20 ? 130 : 100;
      var force = (dist - ideal) * 0.014 * pull;
      dx = (dx / Math.max(1, dist)) * force; dy = (dy / Math.max(1, dist)) * force;
      pa.x += dx; pa.y += dy; pb.x -= dx; pb.y -= dy;
    });
    nodes.forEach(function (n) {
      if (n.id === focusId) return;
      var p = positions[n.id];
      p.x += (cx - p.x) * 0.006;
      p.y += (cy - p.y) * 0.006;
    });
  }
}

// –– 工程网格星图动画主循环 ––
function animateConceptNetwork(canvas, ctx, W, H, data) {
  if (_netRAF) { cancelAnimationFrame(_netRAF); _netRAF = null; }

  // 每节点脉动参数（首次生成，复用）
  if (!data._twinkle) {
    data._twinkle = {};
    (data.nodes || []).forEach(function (n) {
      data._twinkle[n.id] = {
        phase: Math.random() * Math.PI * 2,
        freq:  0.3 + Math.random() * 0.6,
        ampR:  0.08 + Math.random() * 0.12,
      };
    });
  }

  // 网格参数
  var GRID = 26;           // 小格间距 px
  var MAJOR = 5;           // 每 N 格画一条粗线
  var ROT_SPEED = 0.00012; // rad/frame ≈ 0.41°/s，约 14 分钟一圈

  var t0 = performance.now();

  function frame(now) {
    var t         = (now - t0) / 1000;
    var allNodes  = data.nodes || [];
    var allEdges  = data.edges || [];
    var visible   = networkState.visibleNodes;
    var focusId   = networkState.focusNode;
    var hoverId   = networkState.hoverNode;
    var positions = networkState.positions;

    if (networkState.needsLayout) {
      _computeConceptLayout(W, H, data);
      networkState.needsLayout = false;
    }

    _netRotAngle += ROT_SPEED;

    var nodes    = allNodes.filter(function (n) { return visible.has(n.id); });
    var visEdges = allEdges.filter(function (e) { return visible.has(e.source) && visible.has(e.target); });

    // ── 静态背景：米色底 + 工程网格 ──
    ctx.fillStyle = '#EBE6D9';
    ctx.fillRect(0, 0, W, H);

    // 细格
    ctx.beginPath();
    for (var gx = GRID; gx < W; gx += GRID) {
      if (Math.round(gx / GRID) % MAJOR === 0) continue;
      ctx.moveTo(gx, 0); ctx.lineTo(gx, H);
    }
    for (var gy = GRID; gy < H; gy += GRID) {
      if (Math.round(gy / GRID) % MAJOR === 0) continue;
      ctx.moveTo(0, gy); ctx.lineTo(W, gy);
    }
    ctx.strokeStyle = 'rgba(140,132,112,0.13)';
    ctx.lineWidth   = 0.5;
    ctx.stroke();

    // 粗格
    ctx.beginPath();
    for (var gx = 0; gx <= W; gx += GRID * MAJOR) {
      ctx.moveTo(gx, 0); ctx.lineTo(gx, H);
    }
    for (var gy = 0; gy <= H; gy += GRID * MAJOR) {
      ctx.moveTo(0, gy); ctx.lineTo(W, gy);
    }
    ctx.strokeStyle = 'rgba(120,112,92,0.22)';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    if (!nodes.length) {
      ctx.fillStyle = 'rgba(90,82,62,0.45)';
      ctx.font      = "14px 'Share Tech Mono', monospace";
      ctx.textAlign = 'center';
      ctx.fillText('还没有 [[双链]] 或 #tag', W / 2, H / 2);
      _netRAF = requestAnimationFrame(frame);
      return;
    }

    // ── 旋转坐标系（仅网络层）──
    var cx = W / 2, cy = H / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(_netRotAngle);
    ctx.translate(-cx, -cy);

    // ── 边（星图连线：渐变，节点端较深，中段淡）──
    visEdges.forEach(function (e) {
      var pa = positions[e.source], pb = positions[e.target];
      if (!pa || !pb) return;
      var w    = e.weight || 1;
      var isFE = (e.source === focusId || e.target === focusId);
      var baseA = isFE ? 0.45 : Math.min(0.22, 0.05 + 0.045 * w);
      var grad  = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      grad.addColorStop(0,   'rgba(100,88,60,' + baseA.toFixed(3) + ')');
      grad.addColorStop(0.5, 'rgba(100,88,60,' + (baseA * 0.15).toFixed(3) + ')');
      grad.addColorStop(1,   'rgba(100,88,60,' + baseA.toFixed(3) + ')');
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
      ctx.strokeStyle = grad;
      ctx.lineWidth   = isFE ? 1.2 : 0.7;
      ctx.stroke();
    });

    // ── 节点（小圆点 + 脉动光晕）──
    nodes.forEach(function (n) {
      var p = positions[n.id];
      if (!p) return;
      var tw      = data._twinkle[n.id] || { phase: 0, freq: 0.45, ampR: 0.10 };
      var pulse   = Math.sin(t * tw.freq * Math.PI * 2 + tw.phase);
      var isFocus = (n.id === focusId);
      var isHover = (n.id === hoverId);
      var lit     = isFocus || n.anchor || isHover;

      // 缩小尺寸：max 1.8, min 6  (原来 2.5/9)
      var baseR = Math.max(1.8, Math.min(6, 1.4 + Math.sqrt(n.freq || 1) * 1.2));
      var r     = (isFocus ? baseR * 1.4 : isHover ? baseR * 1.2 : baseR) * (1 + tw.ampR * pulse);

      // 光晕（浅背景下用低透明度暖金）
      var glowR = r + (lit ? 11 : 6) + (lit ? 3 : 1) * pulse;
      var glowA = lit ? (0.22 + 0.08 * pulse) : (0.06 + 0.03 * pulse);
      var grd   = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, glowR));
      grd.addColorStop(0, 'rgba(180,138,40,' + glowA.toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(180,138,40,0)');
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, glowR), 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      // 焦点/锚点轨道环
      if (isFocus || n.anchor) {
        var ringR = r + (isFocus ? 8 : 5) + 1.5 * pulse;
        ctx.beginPath();
        ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(180,138,40,' + (0.45 + 0.15 * pulse).toFixed(3) + ')';
        ctx.lineWidth   = isFocus ? 1.4 : 1.0;
        ctx.stroke();
      }

      // 点本体
      var bodyA = lit ? (0.92 + 0.08 * pulse) : (0.48 + 0.18 * pulse);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = lit
        ? 'rgba(180,138,40,' + bodyA.toFixed(3) + ')'
        : 'rgba(72,65,50,' + bodyA.toFixed(3) + ')';
      ctx.fill();

      // 焦点节点标签（抵消旋转，保持文字竖直）
      if (isFocus) {
        ctx.save();
        ctx.translate(p.x, p.y + r + 16);
        ctx.rotate(-_netRotAngle);
        var label  = n.label || n.id;
        if (label.length > 14) label = label.slice(0, 14) + '…';
        var prefix = n.kind === 'tag' ? '#' : '';
        ctx.fillStyle  = 'rgba(160,120,30,0.95)';
        ctx.font       = "bold 11px 'Share Tech Mono', sans-serif";
        ctx.textAlign  = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText((n.anchor ? '⚓ ' : '') + prefix + label, 0, 0);
        ctx.restore();
      }
    });

    ctx.restore(); // 结束旋转坐标系

    // ── HUD（不旋转）──
    if (!focusId) {
      ctx.fillStyle    = 'rgba(90,80,55,0.35)';
      ctx.font         = "11px 'Share Tech Mono', monospace";
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('TOP ' + nodes.length + ' NODES · 悬浮看详情 · 点击展开邻居', W / 2, 22);
    } else {
      ctx.fillStyle    = 'rgba(170,128,35,0.8)';
      ctx.font         = "11px 'Share Tech Mono', monospace";
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('DEPTH ' + networkState.depth + ' · ' + nodes.length + ' NODES · 点击焦点节点返回全局', W / 2, 22);
    }

    _netRAF = requestAnimationFrame(frame);
  }

  _netRAF = requestAnimationFrame(frame);
}

// –– 注入控制栏 ––
function injectNetworkControls() {
  if (document.getElementById('network-depth-control')) return;

  var canvas = document.getElementById('network-canvas');
  if (!canvas) return;
  var parent = canvas.parentElement;

  var bar = document.createElement('div');
  bar.id = 'network-depth-control';
  bar.style.cssText = [
    'display:flex', 'align-items:center', 'gap:12px',
    'padding:10px 18px', 'margin-bottom:14px',
    'background:var(--surface)', 'border-radius:12px',
    'box-shadow:4px 4px 11px var(--shadow-dark-subtle), -3px -3px 8px var(--shadow-light)',
    'font-family:\'Share Tech Mono\',monospace', 'font-size:12px', 'color:var(--text-dim)'
  ].join(';');

  bar.innerHTML = [
    '<span>展开深度 / DEPTH</span>',
    '<input id="depth-slider" type="range" min="1" max="4" value="2" style="width:100px;accent-color:var(--accent);">',
    '<span id="depth-label" style="color:var(--accent);font-weight:600;min-width:16px">2</span>',
    '<span style="color:var(--text-light);font-size:11px;margin-left:8px">点击节点展开 · 再次点击返回全局</span>'
  ].join('');

  parent.insertBefore(bar, canvas);

  document.getElementById('depth-slider').addEventListener('input', function () {
    var v = parseInt(this.value);
    document.getElementById('depth-label').textContent = v;
    networkState.depth = v;
    if (networkState.focusNode && networkData) {
      networkState.visibleNodes = getNeighbors(networkState.focusNode, v, networkData);
      networkState.positions    = {};
      networkState.needsLayout  = true;
    }
  });
}

// 旧的桶级网络（embedding 模式仍然能切到）
function drawBucketNetwork(ctx, W, H, data) {
  var nodes = data.nodes || [], edges = data.edges || [];
  if (!nodes.length) {
    ctx.fillStyle = '#C7C9BC'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle = '#8A8070';
    ctx.fillText('没有记忆桶', W/2, H/2);
    return;
  }
  var positions = {};
  var cx = W/2, cy = H/2;
  nodes.forEach(function(n, i) {
    var a = (i/nodes.length)*Math.PI*2;
    var r = Math.min(W,H)*0.35;
    positions[n.id] = { x: cx+Math.cos(a)*r+(Math.random()-0.5)*50, y: cy+Math.sin(a)*r+(Math.random()-0.5)*50 };
  });
  for (var iter=0; iter<60; iter++) {
    for (var i=0; i<nodes.length; i++) for (var j=i+1; j<nodes.length; j++) {
      var pa=positions[nodes[i].id], pb=positions[nodes[j].id];
      var dx=pb.x-pa.x, dy=pb.y-pa.y;
      var dist=Math.max(1, Math.sqrt(dx*dx+dy*dy));
      var f=800/(dist*dist);
      pa.x-=(dx/dist)*f; pa.y-=(dy/dist)*f; pb.x+=(dx/dist)*f; pb.y+=(dy/dist)*f;
    }
    edges.forEach(function(e) {
      var pa=positions[e.source], pb=positions[e.target];
      if (!pa||!pb) return;
      var dx=pb.x-pa.x, dy=pb.y-pa.y;
      var dist=Math.sqrt(dx*dx+dy*dy);
      var w = e.weight || 0.5;
      var f = (dist-120)*0.01*w;
      pa.x += (dx/Math.max(1,dist))*f; pa.y += (dy/Math.max(1,dist))*f;
      pb.x -= (dx/Math.max(1,dist))*f; pb.y -= (dy/Math.max(1,dist))*f;
    });
    nodes.forEach(function(n){var p=positions[n.id]; p.x+=(cx-p.x)*0.01; p.y+=(cy-p.y)*0.01;});
  }
  ctx.fillStyle='#C7C9BC'; ctx.fillRect(0,0,W,H);
  edges.forEach(function(e){
    var pa=positions[e.source], pb=positions[e.target]; if(!pa||!pb) return;
    var w=e.weight||0.5;
    ctx.beginPath(); ctx.moveTo(pa.x,pa.y); ctx.lineTo(pb.x,pb.y);
    ctx.strokeStyle='rgba(47,79,79,'+(w*0.35)+')'; ctx.lineWidth=Math.max(0.5,w*2);
    ctx.stroke();
  });
  var colors = { dynamic:'#2F4F4F', permanent:'#9A7B4F', feel:'#8B6A6A', archived:'#B0A590' };
  nodes.forEach(function(n){
    var p=positions[n.id];
    var r=Math.max(4, Math.min(14, (n.score||0)*0.8));
    var color = colors[n.type] || '#2F4F4F';
    // anchor 节点：朱砂外圈 (#10)
    if (n.anchor) {
      ctx.beginPath(); ctx.arc(p.x,p.y,r+6,0,Math.PI*2);
      ctx.strokeStyle='#B85C3C'; ctx.lineWidth=2; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(p.x,p.y,r+4,0,Math.PI*2); ctx.fillStyle=color+'15'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fillStyle=n.resolved?color+'70':color; ctx.fill();
    if (n.pinned) { ctx.strokeStyle='#9A7B4F'; ctx.lineWidth=2; ctx.stroke(); }
    var name=(n.anchor?'⚓ ':'')+(n.name||n.id); if (name.length>12) name=name.slice(0,12)+'…';
    ctx.fillStyle=n.anchor?'#B85C3C':'#3A3530';
    ctx.font=n.anchor?"bold 11px 'Share Tech Mono',monospace":"11px 'Share Tech Mono',monospace";
    ctx.textAlign='center';
    ctx.fillText(name, p.x, p.y+r+14);
  });
}

function esc(s) {
  if (!s) return '';
  // 兜底：意外传入对象/数组时输出可读 JSON，绝不让 [object Object] 露到任何用户可见处。
  if (typeof s === 'object') {
    try { s = JSON.stringify(s); } catch (e) { s = ''; }
  }
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

// iter 1.9 A: plan weight 的中文档位锚点 / semantic anchors for plan weight
//   <0.30 → 轻；<0.62 → 中；<0.88 → 重；其余 → 必须
//   边界用插值锚点的中点，避免「拖到 0.50 显示中、0.51 突变成重」
function weightAnchorLabel(w) {
  if (w == null) return '';
  if (w < 0.30) return '轻';
  if (w < 0.62) return '中';
  if (w < 0.88) return '重';
  return '必须';
}
window._updateWeightLabel = function(v) {
  var el = document.getElementById('edit-weight-val');
  if (el) el.textContent = v + '% · ' + weightAnchorLabel(parseFloat(v) / 100);
};

function parseBucketDate(iso) {
  if (iso === null || iso === undefined || String(iso).trim() === '') return null;
  var d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstValidBucketTime() {
  for (var i = 0; i < arguments.length; i++) {
    var parsed = parseBucketDate(arguments[i]);
    if (parsed) return parsed;
  }
  return null;
}

function formatTimeAgo(iso) {
  var d = parseBucketDate(iso);
  if (!d) return '—';
  var now = new Date();
  var hours = Math.floor((now - d) / 3600000);
  if (hours < 1) return '刚刚';
  if (hours < 24) return hours + 'h前';
  var days = Math.floor(hours / 24);
  if (days < 30) return days + 'd前';
  return Math.floor(days/30) + 'mo前';
}

function formatCompactBucketTime(iso) {
  var d = parseBucketDate(iso);
  if (!d) return '—';
  function pad(value) { return String(value).padStart(2, '0'); }
  var now = new Date();
  var datePart = d.getFullYear() === now.getFullYear()
    ? pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return datePart + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function formatExactBucketTime(iso) {
  var d = parseBucketDate(iso);
  return d ? d.toLocaleString('zh-CN', { hour12: false }) : '—';
}

function daysSince(iso) {
  var d = parseBucketDate(iso);
  if (!d) return 0;
  return (Date.now() - d.getTime()) / 86400000;
}

// ============================================================
// 小巧思 helpers — feel 表情 / 像素小黄鸡蛋 / 随机 placeholder
// ============================================================

// feel 表情：嘴形由 valence 决定，眼睛由 arousal 决定，每条 feel 的「脸」都是算出来的
function feelFace(v, a) {
  v = (v == null ? 0.5 : v); a = (a == null ? 0.3 : a);
  var mouth = v >= 0.62 ? 'M5 10 Q8 13 11 10'          // 微笑
            : v <= 0.38 ? 'M5 11.5 Q8 8.5 11 11.5'     // 沮丧
                        : 'M5.5 10.7 L10.5 10.7';       // 平
  var eye = a >= 0.6
        ? '<circle cx="6" cy="6.6" r="1.5"/><circle cx="10" cy="6.6" r="1.5"/>'                               // 睁大（激动/紧张）
        : (a <= 0.3
            ? '<path d="M4.7 6.9 Q6 6.1 7.3 6.9" fill="none" stroke-width="1.1"/><path d="M8.7 6.9 Q10 6.1 11.3 6.9" fill="none" stroke-width="1.1"/>'  // 半阖（困倦/平静）
            : '<circle cx="6" cy="6.6" r="1"/><circle cx="10" cy="6.6" r="1"/>');                              // 普通
  var color = v >= 0.62 ? 'var(--positive)' : (v <= 0.38 ? 'var(--negative)' : 'var(--text-dim)');
  // 高唤醒+高效价时加个小腮红点
  var blush = (a >= 0.6 && v >= 0.6) ? '<circle cx="3.6" cy="9.2" r="0.9" fill="var(--accent)" opacity="0.5" stroke="none"/><circle cx="12.4" cy="9.2" r="0.9" fill="var(--accent)" opacity="0.5" stroke="none"/>' : '';
  return '<svg class="feel-face" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style="color:' + color + ';vertical-align:-3px;">' +
    '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
    blush +
    '<g fill="currentColor" stroke="currentColor">' + eye + '</g>' +
    '<path d="' + mouth + '" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</svg>';
}

// ============================================================
// 像素电子宠物 · ObPet（HTML5 Canvas 点阵小鸡）
//   字符→颜色：. 透明 / Y 鸡黄 / O 深黄冠 / W 蛋壳白 / S 壳影
//   B 嘴橙 / K 豆豆眼 / L 蓝领结 / l 深蓝结 / P 波点蓝 / r 腮红
//   三态：egg 蛋（晃动）→ chick 破壳雏鸡 → big 走来走去的肥嘟嘟大吉
//   记忆越多越大；Hold / Breath 事件触发破壳 or 开心跳。像捏乐高一样的 2D 像素数组。
// ============================================================
window.ObPet = (function () {
  var PAL = { '.':null, Y:'#FFD452', O:'#E0A92E', W:'#FFFFFF', S:'#E8DFC2', B:'#FF9F43', K:'#3A2E1E', L:'#5B8FD6', l:'#3E6FB0', P:'#7FB0E6', r:'#F6B6C2' };
  var EGG = [
    '................','......SSSS......','.....SWWWWS.....','....SWWWWWWS....',
    '...SWWWPWWWWS...','...SWWWWWWWWS...','..SWWWWWWWWWWS..','..SWWPWWWWWWWS..',
    '..SWWWWWWWPWWS..','..SWWWWWWWWWWS..','...SWWWPWWWWS...','...SWWWWWWWWS...',
    '....SWWWWWWS....','.....SWWWWS.....','......SSSS......','................'];
  var EGG_CRACK = [
    '................','......SSSS......','.....SWWWWS.....','....SWWWWWWS....',
    '...SWWKWWKWWS...','...SWWWWWWWWS...','..SWWWBBWWWWWS..','..SOWWOWWOWWOS..',
    '..SWOWWOWWOWWS..','..SWWWWWWWWWWS..','...SWWWWWWWWS...','...SWWWWWWWWS...',
    '....SWWWWWWS....','.....SWWWWS.....','......SSSS......','................'];
  var CHICK = [
    '................','......YYYY......','.....YYYYYY.....','....YYYYYYYY....',
    '....YKYYYYKY....','....YYYYYYYY....','....YYYBBYYY....','...YYYYYYYYYY...',
    '..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','...YYYYYYYYYY...',
    '....YYYYYYYY....','.....YYYYYY.....','.....B....B.....','....BB....BB....'];
  var CHICK_BLINK = [
    '................','......YYYY......','.....YYYYYY.....','....YYYYYYYY....',
    '....YYYYYYYY....','....YYYYYYYY....','....YYYBBYYY....','...YYYYYYYYYY...',
    '..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','...YYYYYYYYYY...',
    '....YYYYYYYY....','.....YYYYYY.....','.....B....B.....','....BB....BB....'];
  var BIG1 = [
    '.......OO.......','......YYYY......','.....YYYYYY.....','....YKYYYYKY....',
    '...rYYYYYYYYr...','....YYYBBYYY....','...YYYYYYYYYY...','..YYYYYYYYYYYY..',
    '..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','...YYYYYYYYYY...',
    '....YYLllLYY....','.....YYYYYY.....','....B......B....','...BB......BB...'];
  var BIG2 = [
    '.......OO.......','......YYYY......','.....YYYYYY.....','....YKYYYYKY....',
    '...rYYYYYYYYr...','....YYYBBYYY....','...YYYYYYYYYY...','..YYYYYYYYYYYY..',
    '..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','..YYYYYYYYYYYY..','...YYYYYYYYYY...',
    '....YYLllLYY....','.....YYYYYY.....','.....B....B.....','....BB....BB....'];
  var SPR = 16, W = 64, H = 24, SCALE = 2;
  var host, cv, ctx, raf = null, t0 = 0;
  var st = { stage:'egg', count:0, x:24, dir:1, frame:0, blinkT:0, hatchT:0, hopT:0, started:false, dragMoved:false, suppressClickUntil:0, drops:0, tickles:0, tickleTimer:null, idleTimer:null };
  var TICKLE_LINES = ['别碰我。','……你手痒是吧。','再碰试试。','咬你哦。','我记仇的。','你有正事吗。','……烦。','我是记忆系统不是宠物。','下次再碰我就把你的桶全归档。','别挠了，痒。'];

  function wakePet() {
    if (!host) return;
    host.classList.remove('sleeping','play-dead');
    clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(function() {
      if (!host.classList.contains('grabbed') && !host.classList.contains('raging')) {
        host.classList.add('sleeping'); setTip('zZ…鸡也要整理记忆。');
      }
    }, 90000);
  }
  function pointNearElement(x, y, selector, distance) {
    var el=document.querySelector(selector); if(!el) return false;
    var r=el.getBoundingClientRect(), cx=Math.max(r.left,Math.min(x,r.right)), cy=Math.max(r.top,Math.min(y,r.bottom));
    return Math.hypot(x-cx,y-cy) <= distance;
  }
  function dropRemark(x, y) {
    var hour=new Date().getHours();
    if (y < 55) return '太高了……我恐高。';
    if (pointNearElement(x,y,'.bucket-pager',80)) return '这位置以前是我的。';
    if (pointNearElement(x,y,'.search-bar',90)) return '你找什么？我帮你啄。';
    if (document.getElementById('settings-view') && document.getElementById('settings-view').style.display !== 'none') return '不要乱动我的饲料配方。';
    if (hour < 5 || hour >= 23) return '你怎么还没睡？';
    return ['这里视野不错。','好吧，就停这里。','人类的桌面真乱。'][st.drops % 3];
  }

  function clampPetPosition(x, y) {
    var w = host ? host.offsetWidth : 128, h = host ? host.offsetHeight : 48;
    return {
      x: Math.max(8, Math.min(window.innerWidth - w - 8, x)),
      y: Math.max(8, Math.min(window.innerHeight - h - 8, y))
    };
  }
  function placePet(x, y, persist) {
    var p = clampPetPosition(x, y);
    host.style.left = p.x + 'px'; host.style.top = p.y + 'px';
    host.style.right = 'auto'; host.style.bottom = 'auto';
    if (persist) localStorage.setItem('ombreChickPosition', JSON.stringify(p));
  }
  function restorePetPosition() {
    try {
      var p = JSON.parse(localStorage.getItem('ombreChickPosition') || 'null');
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) placePet(p.x, p.y, false);
    } catch (e) {}
  }
  function installPetDrag() {
    if (host.dataset.dragReady) return;
    host.dataset.dragReady = '1';
    var drag = null;
    var grabs = ['可恶的人类！', '喂，轻一点！', '我不是翻页键！', '抓鸡要负责的！', '咯咯咯——放我下来！'];
    host.addEventListener('pointerdown', function(e) {
      if (e.button != null && e.button !== 0) return;
      var r = host.getBoundingClientRect();
      drag = {id:e.pointerId, dx:e.clientX-r.left, dy:e.clientY-r.top, sx:e.clientX, sy:e.clientY, samples:[e.clientX]};
      st.dragMoved = false;
      wakePet();
      host.setPointerCapture(e.pointerId);
      host.classList.add('grabbed');
      setTip(grabs[Math.floor(Math.random()*grabs.length)]);
      e.preventDefault();
    });
    host.addEventListener('pointermove', function(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (Math.abs(e.clientX-drag.sx) + Math.abs(e.clientY-drag.sy) > 5) st.dragMoved = true;
      drag.samples.push(e.clientX); if (drag.samples.length > 10) drag.samples.shift();
      placePet(e.clientX-drag.dx, e.clientY-drag.dy, false);
      e.preventDefault();
    });
    function drop(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var r = host.getBoundingClientRect();
      placePet(r.left, r.top, true);
      host.classList.remove('grabbed');
      if (st.dragMoved) st.suppressClickUntil = Date.now() + 350;
      var turns=0, last=0;
      for(var i=1;i<drag.samples.length;i++){ var d=drag.samples[i]-drag.samples[i-1], sign=d>4?1:(d<-4?-1:0); if(sign&&last&&sign!==last) turns++; if(sign) last=sign; }
      st.drops++;
      if (turns >= 3) {
        host.classList.add('dizzy'); setTip('天旋地转……你礼貌吗？');
        setTimeout(function(){host.classList.remove('dizzy');},1200);
      } else if (st.drops % 8 === 0) {
        host.classList.add('play-dead'); setTip('……');
        setTimeout(function(){ host.classList.remove('play-dead'); setTip('偷偷睁眼。你走了吗？'); },2200);
      } else setTip(st.dragMoved ? dropRemark(r.left+r.width/2,r.top+r.height/2) : '戳我干嘛？');
      drag = null;
      wakePet();
    }
    host.addEventListener('pointerup', drop);
    host.addEventListener('pointercancel', drop);
    host.addEventListener('click', function(e) {
      if (Date.now() < st.suppressClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    window.addEventListener('resize', function() {
      if (host.style.left) { var r=host.getBoundingClientRect(); placePet(r.left,r.top,true); }
    });
  }

  function ensure() {
    host = document.getElementById('ob-chick');
    if (!host) { host = document.createElement('div'); host.id = 'ob-chick'; document.body.appendChild(host); }
    if (!cv) {
      host.style.width = 'auto'; host.style.height = 'auto';
      host.innerHTML = '<canvas width="' + W + '" height="' + H + '" style="display:block;width:' + (W*SCALE) + 'px;height:' + (H*SCALE) + 'px;image-rendering:pixelated;"></canvas><div class="chick-tip"></div>';
      cv = host.querySelector('canvas'); ctx = cv.getContext('2d');
      host.addEventListener('click', function (e) {
        var r = cv.getBoundingClientRect();
        var canvasX = ((e.clientX - r.left) / Math.max(r.width, 1)) * W;
        var spriteX = st.stage === 'big' ? st.x : 24;
        var side = canvasX >= spriteX && canvasX <= spriteX + SPR
          && ((canvasX - spriteX) / SPR < .38 || (canvasX - spriteX) / SPR > .62);
        host.dataset.lastPetAction = side ? 'tickle' : 'poke';
        react(side ? 'tickle' : 'poke');
      });
      installPetDrag();
      restorePetPosition();
      ['pointerdown','keydown','wheel'].forEach(function(name){ document.addEventListener(name,wakePet,{passive:true}); });
      wakePet();
    }
  }
  function setTip(s) { var t = host && host.querySelector('.chick-tip'); if (t) t.textContent = s; }
  function stageFor(n) { return n < 1 ? 'egg' : (n < 25 ? 'chick' : 'big'); }
  function draw(frame, ox, oy, flip) {
    for (var y = 0; y < frame.length; y++) { var row = frame[y];
      for (var x = 0; x < row.length; x++) { var col = PAL[row[x]]; if (!col) continue;
        ctx.fillStyle = col; ctx.fillRect((flip ? ox + (SPR-1-x) : ox + x), oy + y, 1, 1);
      } }
  }
  function render(now) {
    raf = requestAnimationFrame(render);
    var dt = now - (t0 || now); t0 = now;
    ctx.clearRect(0, 0, W, H);
    var oy = H - SPR;
    if (st.hatchT > 0) {                              // 破壳过场
      st.hatchT -= dt;
      var shake = (Math.floor(now / 70) % 2) ? 1 : -1;
      if (st.hatchT > 600) draw(EGG, 24 + shake, oy, false);
      else if (st.hatchT > 250) draw(EGG_CRACK, 24 + shake, oy, false);
      else draw(CHICK, 24, oy, false);
      if (st.hatchT <= 0) { st.stage = stageFor(st.count); st.x = 24; }
    } else if (st.stage === 'egg') {                  // 蛋：轻晃
      draw(EGG, 24 + Math.round(Math.sin(now / 420)), oy, false);
    } else if (st.stage === 'chick') {                // 雏鸡：眨眼 + 微微点头
      st.blinkT += dt;
      var bob = (Math.floor(now / 320) % 2) ? 0 : -1;
      draw((st.blinkT % 3200) < 150 ? CHICK_BLINK : CHICK, 24, oy + bob, false);
    } else {                                          // 大吉：走来走去
      var hop = 0;
      if (st.hopT > 0) { st.hopT -= dt; hop = Math.round(Math.sin((1 - st.hopT / 300) * Math.PI) * -3); }
      st.frame += dt; var step = Math.floor(st.frame / 150) % 2;
      st.x += st.dir * dt * 0.012;
      if (st.x < 2) { st.x = 2; st.dir = 1; } else if (st.x > W - SPR - 2) { st.x = W - SPR - 2; st.dir = -1; }
      draw(step ? BIG1 : BIG2, Math.round(st.x), oy + (step ? 0 : -1) + hop, st.dir < 0);
    }
  }
  function start() { if (!raf) { t0 = 0; raf = requestAnimationFrame(render); } }
  function setCount(n) {
    ensure(); n = n || 0; var prev = st.stage, oldCount=st.count, wasStarted=st.started; st.count = n; var s = stageFor(n);
    if (st.started && prev === 'egg' && s !== 'egg') st.hatchT = 1000;   // 首次破壳过场
    else if (!st.started) st.stage = s;
    st.started = true;
    if (wasStarted && n > oldCount && oldCount > 0) { st.hopT=300; setTip('这条我记住了。'); }
    else setTip(s === 'egg' ? '一颗蛋 · 记点东西我就孵化' : (s === 'chick' ? '破壳啦 · ' + n + ' 段记忆' : '肥嘟嘟大吉 · ' + n + ' 段记忆'));
    start();
  }
  function react(type) {
    ensure();
    wakePet();
    if (st.stage === 'egg' && st.hatchT <= 0) { st.hatchT = 1000; setTip('咔嚓——破壳！'); }
    else {
      st.hopT = 300;
      var lines={
        forget:'我会替你放远一点。',test_create:'护目镜戴好，开始实验。',test_delete:'假的，清理完了。',protect:'这条不行。',forgive:'……算了，原谅你。',secret:'咯？你居然知道暗号。',
        rate_limit:'最近发现你有429的问题。不过那是你的问题，不是我的。我建议你冷静一下，就像我正在做的那样。🐤',
        invalid_key:'你的key坏了。我试了好几次——骗你的。不过不是我的问题。去检查一下。',
        grow_empty:'你喂了我一段话但我没消化成功。可能是我太小了，也可能是你的API欠费了。大概率是后者。',
        embedding_rebuild:'正在重新理解所有的记忆。这需要一点时间。你可以去喝杯水，不喝也行，反正我知道你今天肯定没喝够水。',
        empty:'这里什么都没有。说点什么吧，我会记住的。大概。',
        connection_error:'找不到我自己。这在存在主义上说得通，但在技术上不应该。检查一下网络。',
        decay:'正在忘记一些不重要的事。别担心，重要的我会留着。大概。'
      };
      if (type === 'tickle') {
        clearTimeout(st.tickleTimer);
        setTip(TICKLE_LINES[Math.min(st.tickles, TICKLE_LINES.length - 1)]);
        st.tickles++;
        host.classList.remove('tickled'); void host.offsetWidth; host.classList.add('tickled');
        setTimeout(function(){ host.classList.remove('tickled'); },700);
        st.tickleTimer=setTimeout(function(){st.tickles=0;},8000);
      } else setTip(lines[type] || (type === 'breath' ? 'breath～它跳了一下' : (type === 'hold' ? '记住啦 :)' : '戳我干嘛 :)')));
      host.classList.toggle('lab-mode',type==='test_create');
      if(type==='test_create') setTimeout(function(){host.classList.remove('lab-mode');},4000);
      if(type==='test_delete') setTimeout(function(){host.classList.remove('lab-mode');},1500);
    }
    start();
  }
  return { setCount: setCount, react: react };
})();

function chickReactForApiProblem(message) {
  if (!window.ObPet) return;
  var text = String(message || '').toLowerCase();
  if (/429|rate.?limit|限频|限流/.test(text)) window.ObPet.react('rate_limit');
  else if (/401|invalid.*key|key.*invalid|api.?key.*(无效|错误)|鉴权失败/.test(text)) window.ObPet.react('invalid_key');
}

function updateChick(total) { if (window.ObPet) ObPet.setCount(total || 0); }

// =====================================================
// ⑨b 小鸡彩蛋：天气 / 时段 / 最近记忆「心理状态」联动
// 纯装饰、可有可无：悬停时把这三样揉成一句话塞进 .chick-tip，
// 并按时段给画布上色。任何一环失败都静默跳过，不影响小鸡本体。
// =====================================================
(function ObChickFlavor(){
  var weather = null;  // {emoji, desc, temp} | null

  function getBuckets(){ try { return allBuckets || []; } catch(e){ return (window.allBuckets || []); } }
  function pick(a){ return a[Math.floor(Math.random()*a.length)]; }

  function timeOfDay(){
    var h = new Date().getHours();
    if (h>=5 && h<8)   return {cls:'tod-dawn',  hi:['天刚亮','清晨好','早上好呀'], emoji:'🌅'};
    if (h>=8 && h<17)  return {cls:'tod-day',   hi:['白天','此刻','今天'],         emoji:'🌞'};
    if (h>=17 && h<20) return {cls:'tod-dusk',  hi:['黄昏','傍晚','日落时分'],     emoji:'🌇'};
    return                    {cls:'tod-night', hi:['夜里','这么晚还醒着','深夜'], emoji:'🌙'};
  }

  // 最近活跃的几条普通桶，平均 valence/arousal → 心情标签（Russell 象限）
  function recentMood(){
    var bs = getBuckets().filter(function(b){
      return b && typeof b.valence==='number'
        && b.type!=='letter' && b.type!=='plan' && b.type!=='archived';
    });
    if (!bs.length) return null;
    bs.sort(function(a,b){ return (b.last_active||b.created||'').localeCompare(a.last_active||a.created||''); });
    var top = bs.slice(0,8), v=0, a=0;
    top.forEach(function(b){ v += (b.valence!=null?b.valence:0.5); a += (b.arousal!=null?b.arousal:0.3); });
    v/=top.length; a/=top.length;
    if (v>=0.62) return a>=0.55 ? {label:'雀跃',     emoji:'✨'} : {label:'暖洋洋',   emoji:'☺️'};
    if (v<=0.40) return a>=0.55 ? {label:'有点烦躁', emoji:'😖'} : {label:'有点低落', emoji:'🥺'};
    return            a>=0.55 ? {label:'微微紧绷', emoji:'😬'} : {label:'平平静静', emoji:'🍃'};
  }


  function compose(){
    // 偶尔来一句纯废话
    if (Math.random()<0.18) return pick([
      '我在站岗 🐤','刚啄了一下你的记忆','别看了，专心 :)','咕… 我也想被记住','存点好的给我孵 🥚','今天也要乖乖的'
    ]);
    var tod = timeOfDay(), mood = recentMood(), parts = [];
    parts.push(pick(tod.hi)+' '+tod.emoji);
    if (weather) parts.push(weather.emoji + (Math.random()<0.5 ? (' '+weather.desc) : (' '+weather.temp+'°')));
    if (mood)    parts.push(mood.emoji + ' 记忆里' + mood.label);
    return parts.join(' · ');
  }

  function applyTint(){
    var host = document.getElementById('ob-chick'); if (!host) return;
    host.classList.remove('tod-dawn','tod-day','tod-dusk','tod-night');
    host.classList.add(timeOfDay().cls);
  }

  function hook(){
    var host = document.getElementById('ob-chick');
    if (!host) { return setTimeout(hook, 1000); }   // 小鸡可能还没 ensure()，等一下
    applyTint();
    host.addEventListener('mouseenter', function(){
      var tip = host.querySelector('.chick-tip');
      if (!tip || host.classList.contains('raging')) return;  // 暴走时不抢话
      tip.textContent = compose();
    });
    setInterval(applyTint, 5*60*1000);   // 每 5 分钟跟一次时段
  }

  if (document.readyState !== 'loading') hook();
  else document.addEventListener('DOMContentLoaded', hook);
})();

// 搜索框空闲时，placeholder 偶尔换一句
var _phLines = [
  '搜索记忆…',
  '搜索一段没说出口的话…',
  '找找那个让你停下来的瞬间…',
  '输入一个名字，或一种心情…',
  '它可能藏在某个 #标签 里…',
  '搜一件你以为忘了的事…',
  '某个深夜，某句话，某个人…'
];
function startPlaceholderRotation() {
  var input = document.getElementById('search-input');
  if (!input) return;
  setInterval(function () {
    if (document.activeElement === input || input.value) return;  // 有焦点或有内容时不打扰
    var next = _phLines[Math.floor(Math.random() * _phLines.length)];
    input.style.transition = 'opacity .4s';
    input.style.opacity = '0.45';
    setTimeout(function () { input.placeholder = next; input.style.opacity = '1'; }, 400);
  }, 6500);
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeDetail();
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    // Only hijack '/' when focus is NOT already in a text input / textarea / select
    var tag = document.activeElement && document.activeElement.tagName;
    var editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || (document.activeElement && document.activeElement.isContentEditable);
    if (!editable) {
      e.preventDefault();
      document.getElementById('search-input').focus();
    }
  }
});

// =====================================================
// EASTER EGGS
// =====================================================

// —— 1. Konami Code → 记忆碎片解密 ——
(function(){
  var SEQ = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
  var idx = 0;
  document.addEventListener('keydown', function(e){
    if(e.key === SEQ[idx]){ idx++; if(idx===SEQ.length){ idx=0; _eggKonami(); } }
    else idx = (e.key===SEQ[0]) ? 1 : 0;
  });
})();

function _eggKonami(){
  var ov = document.getElementById('egg-overlay');
  if(!ov){
    ov = document.createElement('div'); ov.id='egg-overlay';
    ov.innerHTML='<div id="egg-terminal"><span id="egg-text"></span><span class="eg-cursor"></span></div>';
    ov.addEventListener('click', function(){ ov.classList.remove('active'); });
    document.body.appendChild(ov);
  }
  ov.classList.add('active');
  var el = document.getElementById('egg-text'); el.innerHTML='';
  var lines = [
    { t:'OMBRE BRAIN  v2.1',        cls:'eg-bright', d:0    },
    { t:'━━━━━━━━━━━━━━━━━━━━━━━━━', cls:'eg-dim',   d:280  },
    { t:'> MEMORY DEFRAG INITIATED…',               d:560  },
    { t:'> SCANNING 记忆碎片 · · ·',                d:1050 },
    { t:'> TEMPORAL LINKS: STABLE',                 d:1850 },
    { t:'> ANCHOR COUNT: OK',                       d:2350 },
    { t:'> EMOTION VECTORS: CALIBRATED',            d:2850 },
    { t:'',                                          d:3150 },
    { t:'你找到了一段隐藏的记忆。',   cls:'eg-bright', d:3450 },
    { t:'它说：',                                    d:4050 },
    { t:'  记忆不是储存过去，',                      d:4550 },
    { t:'  而是为了更清楚地',                        d:4950 },
    { t:'  活在当下。',                              d:5350 },
    { t:'',                                          d:5650 },
    { t:'━━━━━━━━━━━━━━━━━━━━━━━━━', cls:'eg-dim',   d:5850 },
    { t:'[ 点击任意处关闭 ]',         cls:'eg-dim',   d:6100 },
  ];
  lines.forEach(function(l){
    setTimeout(function(){
      var s=document.createElement('span');
      if(l.cls) s.className=l.cls;
      s.textContent=l.t+'\n'; el.appendChild(s);
    }, l.d);
  });
}

// —— 2. 连戳小鸡 7 次 → 暴走 ——
(function(){
  var n=0, tm=null, raging=false;
  document.addEventListener('click',function(e){
    var host=document.getElementById('ob-chick');
    if(!host||!host.contains(e.target)) return;
    if(host.dataset.lastPetAction==='tickle'){ delete host.dataset.lastPetAction; return; }
    delete host.dataset.lastPetAction;
    if(host.dataset.justRaged==='1'){ delete host.dataset.justRaged; if(window.ObPet) ObPet.react('forgive'); return; }
    n++; clearTimeout(tm); tm=setTimeout(function(){n=0;},2000);
    if(n>=7&&!raging){
      raging=true; n=0;
      var tip=host.querySelector('.chick-tip');
      host.classList.add('raging');
      var msgs=['别戳了！','！！！！','我要生气了','好吧……','唉','😤','……好吧 :)'];
      var mi=0, iv=setInterval(function(){
        if(tip) tip.textContent=msgs[mi]||'';
        mi++;
        if(mi>=msgs.length){
          clearInterval(iv);
          host.classList.remove('raging');
          host.dataset.justRaged='1';
          raging=false; n=0;
        }
      }, 380);
    }
  });
})();

// —— 3. 搜索 "ombre" / "我是谁" → 系统自白诗 ——
setTimeout(function(){
  var origSearch = window.doSearch;
  if(typeof origSearch !== 'function') return;
  window.doSearch = function(){
    var q = ((document.getElementById('search-input')||{}).value||'').trim().toLowerCase();
    var magic = ['ombre','我是谁','你是谁','who am i','who are you','ombre brain'];
    if(magic.indexOf(q) !== -1){ _eggPoem(); return; }
    origSearch.apply(this, arguments);
  };
}, 1400);

function _eggPoem(){
  if(document.getElementById('egg-poem-bd')) return;
  var bd=document.createElement('div'); bd.id='egg-poem-bd';
  bd.style.cssText='position:fixed;inset:0;z-index:9997;background:rgba(0,0,0,0.28);backdrop-filter:blur(4px);cursor:pointer;';
  var card=document.createElement('div'); card.id='egg-poem-card';
  card.style.cssText=[
    'position:fixed','top:50%','left:50%','transform:translate(-50%,-50%)',
    'z-index:9998','background:var(--surface-solid)','border-radius:24px',
    'padding:40px 44px','max-width:340px','width:88vw',
    'box-shadow:0 24px 64px rgba(0,0,0,0.22),-4px -4px 24px var(--shadow-light)',
    'font-family:"Cormorant Garamond","Noto Serif SC",serif',
    'font-size:16.5px','line-height:2.05','color:var(--text)','text-align:center','cursor:pointer'
  ].join(';');
  card.innerHTML=
    '<div style="font-family:\'Share Tech Mono\',monospace;font-size:10px;color:var(--text-dim);letter-spacing:3px;margin-bottom:20px;">SYSTEM · IDENTITY</div>'+
    '<div style="font-size:28px;color:var(--accent);margin-bottom:18px;line-height:1;">⚓</div>'+
    '<p style="margin:0;font-style:italic;">我不是储存记忆的容器，<br>我是记忆之间的<strong>空隙</strong>——<br><br>那些没说出口的、<br>以为忘了的、<br>还在等你回来的。</p>'+
    '<div style="margin-top:28px;font-family:\'Share Tech Mono\',monospace;font-size:10px;color:var(--text-dim);">— Ombre Brain &nbsp;·&nbsp; 点击关闭</div>';
  function close(){ card.remove(); bd.remove(); }
  card.onclick=close; bd.onclick=close;
  document.body.appendChild(bd); document.body.appendChild(card);
}

// —— 4. 深夜彩蛋 (00:00 - 00:04) ——
(function(){
  var hr=new Date().getHours(), mn=new Date().getMinutes();
  if(hr!==0||mn>=5) return;
  setTimeout(function(){
    // 心跳灯变金
    var dot=document.getElementById('heartbeat-dot');
    if(dot){ dot.style.background='var(--accent)'; dot.style.boxShadow='0 0 6px 2px rgba(194,152,47,0.5)'; }
    // 右下角浮字
    var card=document.createElement('div');
    card.style.cssText=[
      'position:fixed','bottom:80px','right:18px','z-index:9998',
      'background:var(--surface)','border-radius:14px',
      'padding:12px 18px',
      'font-family:\'Share Tech Mono\',monospace','font-size:11px',
      'color:var(--text-dim)','white-space:pre',
      'box-shadow:4px 4px 14px var(--shadow-dark),-2px -2px 8px var(--shadow-light)',
      'line-height:1.75','opacity:0','transition:opacity .8s','pointer-events:none'
    ].join(';');
    card.textContent='深夜好。\n记忆在固化中。';
    document.body.appendChild(card);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ card.style.opacity='1'; }); });
    setTimeout(function(){
      card.style.opacity='0';
      setTimeout(function(){ card.remove(); }, 900);
    }, 6000);
  }, 2000);
})();

async function runBreathDebug() {
  var query = document.getElementById('breath-query').value.trim();
  var valence = document.getElementById('breath-valence').value;
  var arousal = document.getElementById('breath-arousal').value;
  var results = document.getElementById('breath-results');
  var info = document.getElementById('breath-info');

  if (window.ObPet) ObPet.react('breath');   // 电子宠物：breath 时跳一下/破壳
  results.innerHTML = '<div class="loading">计算中…</div>';

  var url = BASE + '/api/breath-debug?q=' + encodeURIComponent(query);
  if (valence) url += '&valence=' + valence;
  if (arousal) url += '&arousal=' + arousal;

  try {
    var res = await fetch(url);
    var data = await res.json();

    document.getElementById('fs-input').classList.add('active');
    document.getElementById('fs-cand-n').textContent = data.total_candidates + ' 桶';
    document.getElementById('fs-candidates').classList.add('active');
    document.getElementById('fs-scoring').classList.add('active');
    document.getElementById('fs-thresh-n').textContent = '≥' + data.threshold + ' → ' + data.passed_count + ' 通过';
    document.getElementById('fs-threshold').classList.add('active');
    document.getElementById('fs-sort').classList.add('active');

    var w = data.weights;
    info.style.display = '';
    info.innerHTML =
      '<strong>权重配置</strong>&nbsp;' +
      'topic=<code>' + Number(w.topic) + '</code> emotion=<code>' + Number(w.emotion) + '</code> ' +
      'time=<code>' + Number(w.time) + '</code> importance=<code>' + Number(w.importance) + '</code>' +
      ' &nbsp;|&nbsp; 阈值=<code>' + Number(data.threshold) + '</code>' +
      ' &nbsp;|&nbsp; 候选=<code>' + Number(data.total_candidates) + '</code> 桶' +
      ' → 通过=<code>' + Number(data.passed_count) + '</code> 桶' +
      (query ? '' : ' &nbsp;|&nbsp; <em>未输入 query，topic 分数全为 0</em>');

    if (!data.results.length) {
      results.innerHTML = '<div class="loading">无结果</div>';
      return;
    }

    var barColors = {
      topic: '#2F4F4F',
      emotion: '#8B6A6A',
      time: '#9A7B4F',
      importance: '#4A7C59',
    };

    results.innerHTML = data.results.map(function(r, i) {
      var s = r.scores;
      var passed = r.passed_threshold;
      var iconName = r.pinned ? 'pin' : r.resolved ? 'moon' : r.type === 'feel' ? 'droplet' : 'message-circle';
      var icon = '<i data-lucide="' + iconName + '"></i>';
      var bars = Object.entries(s).map(function(entry) {
        var key = entry[0], val = entry[1];
        var pct = Math.round(val * 100);
        var wt = r.weights[key];
        return '<div class="score-bar-group">' +
          '<div class="score-bar-label"><span>' + key + '×' + wt + '</span><span>' + val.toFixed(2) + '</span></div>' +
          '<div class="score-bar-track">' +
            '<div class="score-bar-fill" style="width:' + pct + '%;background:' + barColors[key] + '"></div>' +
          '</div>' +
        '</div>';
      }).join('');

      return '<div class="score-row" title="' + escAttr(r.name) + '">' +
        '<span class="rank">' + (i < 9 ? '0' : '') + (i + 1) + '</span>' +
        '<span class="name">' + icon + ' ' + esc(r.name) + '</span>' +
        '<div class="score-bars">' + bars + '</div>' +
        '<span class="score-final ' + (passed ? 'score-pass' : 'score-fail') + '">' + r.normalized.toFixed(1) + (r.resolved ? '<small>×0.3</small>' : '') + '</span>' +
      '</div>';
    }).join('');
  } catch (e) {
    results.innerHTML = '<div class="loading">请求失败: ' + esc(e.message) + '</div>';
  }
}

document.getElementById('breath-query').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') runBreathDebug();
});

// ===== Embedding 后端摘要 + 迁移 =====
async function refreshEmbInfo() {
  try {
    var r = await fetch(BASE + '/api/embedding/info');
    var d = await r.json();
    if (!d || !d.ok) return;
    document.getElementById('emb-info-backend').textContent = d.api_format || d.backend || '—';
    document.getElementById('emb-info-model').textContent = d.model || '—';
    document.getElementById('emb-info-dim').textContent = d.vector_dim || '—';
    document.getElementById('emb-info-count').textContent = (d.db_count != null ? d.db_count : '—');
    document.getElementById('emb-info-enabled').textContent = d.enabled ? '已启用' : '未启用';
    var embNotice = document.getElementById('emb-key-notice');
    if (embNotice) embNotice.style.display = d.enabled ? 'none' : '';
    var meta = d.db_meta || {};
    var metaTxt = '';
    if (meta.model_name || meta.vector_dim) {
      var dbModel = meta.model_name || '';
      var dbDim = meta.vector_dim || '';
      var mismatch = (dbModel && dbModel !== d.model) || (dbDim && String(dbDim) !== String(d.vector_dim));
      metaTxt = 'embeddings.db 元数据：model=' + esc(dbModel) + ' / dim=' + esc(dbDim);
      if (mismatch) metaTxt += '  ' + _SV.warn + ' 与当前后端不一致，建议触发迁移';
    }
    var queue = d.outbox || null;
    if (queue) {
      if (metaTxt) metaTxt += '<br>';
      metaTxt += '后台索引队列：待处理 ' + Number(queue.pending || 0)
        + ' · 重试中 ' + Number(queue.retrying || 0);
      var circuit = queue.circuit || {};
      if (circuit.state === 'open') {
        metaTxt += ' · <span style="color:var(--negative,#c33)">' + _SV.warn
          + ' 供应商熔断（连续失败 ' + Number(circuit.consecutive_failures || 0) + ' 次）</span>';
      }
    }
    document.getElementById('emb-info-meta').innerHTML = metaTxt;
  } catch (e) {
    // ignore
  }
}

var _embMigratePollTimer = null;
function _renderEmbMigrateStatus(s) {
  var el = document.getElementById('emb-migrate-status');
  if (!s || !s.phase || s.phase === 'idle') {
    el.innerHTML = '';
    return;
  }
  var pct = s.total > 0 ? Math.floor((s.done / s.total) * 100) : 0;
  var html = '阶段：<b>' + esc(s.phase) + '</b>'
    + ' · 进度：' + s.done + ' / ' + s.total + ' (' + pct + '%)'
    + ' · 失败：' + (s.failed_count || 0);
  if (s.message) html += '<br>' + esc(s.message);
  if (s.current_id) html += '<br>当前：<code>' + esc(s.current_id) + '</code>';
  if (s.failed_items && s.failed_items.length) {
    var sample = s.failed_items.slice(0, 3).map(function(it) { return esc(it.bucket_id) + ': ' + esc(it.error); }).join('<br>');
    html += '<br><span style="color:var(--negative,#c33)">失败样本（前 3）：<br>' + sample + '</span>';
  }
  if (s.phase === 'failed' || s.phase === 'publish_failed' || (s.phase === 'completed' && s.failed_count > 0)) {
    if (s.tail_log && s.tail_log.length) {
      html += '<br><details style="margin-top:6px;"><summary>最近 15 行错误日志（点开复制给 AI 排查，不要发给作者）</summary>'
        + '<pre style="white-space:pre-wrap;font-size:11px;background:#222;color:#eee;padding:8px;border-radius:4px;max-height:240px;overflow:auto;">'
        + s.tail_log.map(function(ln) { return esc(ln); }).join('\n')
        + '</pre></details>'
        + '<div style="margin-top:6px;color:var(--text-light);font-size:11px;">这通常是本地环境问题（API key、网络、模型权重）；建议把上面的日志贴给 AI 排查，作者无法看到你机器上的细节。</div>';
    }
  }
  el.innerHTML = html;
}

async function pollEmbMigrateStatus() {
  try {
    var r = await fetch(BASE + '/api/embedding/migrate/status');
    var d = await r.json();
    if (!d || !d.ok) return;
    _renderEmbMigrateStatus(d.status);
    if (d.status && ['completed', 'failed', 'publish_failed'].includes(d.status.phase) && !d.running) {
      // 停止轮询，刷新一次摘要
      if (_embMigratePollTimer) { clearInterval(_embMigratePollTimer); _embMigratePollTimer = null; }
      refreshEmbInfo();
    }
  } catch (e) {
    // ignore
  }
}

function _startEmbMigratePolling() {
  if (_embMigratePollTimer) return;
  pollEmbMigrateStatus();
  _embMigratePollTimer = setInterval(pollEmbMigrateStatus, 3000);
}

// --- 补齐缺失向量（backfill）：只给缺向量的桶补一发，不重算全库 ---
var _embBackfillPollTimer = null;
function _renderBackfillStatus(s) {
  var el = document.getElementById('emb-backfill-status');
  if (!el) return;
  if (!s || s.status === 'idle') { el.innerHTML = ''; return; }
  var html = '';
  if (s.status === 'scanning') {
    html = '扫描全库，找缺向量的桶…';
  } else if (s.status === 'embedding') {
    var tot = s.missing || 0;
    var pct = tot > 0 ? Math.floor(((s.done + s.failed) / tot) * 100) : 0;
    html = '补齐中：<b>' + (s.done + s.failed) + ' / ' + tot + '</b> (' + pct + '%)'
      + ' · 成功 ' + s.done + ' · 失败 ' + (s.failed || 0);
  } else if (s.status === 'queued') {
    html = '<b style="color:var(--positive,#2a8)">' + _SV.ok + ' 已交给后台索引队列：</b>'
      + '待处理 ' + (s.missing || 0) + ' · 本次新加入 ' + (s.queued || 0)
      + ' · 孤儿向量 ' + (s.orphaned || 0) + ' · 已清理 ' + (s.cleaned || 0)
      + (s.cleanup_failed ? ' · <span style="color:var(--negative,#c33)">清理失败 ' + s.cleanup_failed + '</span>' : '')
      + (s.failed ? ' · <span style="color:var(--negative,#c33)">重试中 ' + s.failed + '</span>' : '')
      + '<br><span style="color:var(--text-light)">记忆原文已安全保存；即使网络暂时不可用，服务也会继续重试。</span>';
  } else if (s.status === 'done') {
    if ((s.missing || 0) === 0 && (s.orphaned || 0) === 0) {
      html = '<b style="color:var(--positive,#2a8)">' + _SV.ok + ' 全部桶都有向量，无需补齐。</b>';
    } else {
      html = '<b style="color:var(--positive,#2a8)">' + _SV.ok + ' 完成：</b>扫描 ' + s.scanned
        + ' · 缺失 ' + s.missing + ' · 补齐 ' + s.done
        + ' · 孤儿向量 ' + (s.orphaned || 0) + ' · 已清理 ' + (s.cleaned || 0)
        + (s.cleanup_failed ? ' · <span style="color:var(--negative,#c33)">清理失败 ' + s.cleanup_failed + '</span>' : '')
        + (s.failed ? ' · <span style="color:var(--negative,#c33)">失败 ' + s.failed + '</span>' : '');
    }
  } else if (s.status === 'error') {
    html = '<b style="color:var(--negative,#c33)">' + _SV.err + ' 出错：' + esc(s.error || '') + '</b>';
  }
  el.innerHTML = html;
}

async function pollBackfillStatus() {
  try {
    var r = await fetch(BASE + '/api/embedding/backfill/status');
    var d = await readJsonSafe(r);
    if (!d || !d.ok) return;
    _renderBackfillStatus(d.backfill);
    if (d.backfill && !d.backfill.running) {
      if (_embBackfillPollTimer) { clearInterval(_embBackfillPollTimer); _embBackfillPollTimer = null; }
      var btn = document.getElementById('emb-backfill-btn');
      if (btn) btn.disabled = false;
      refreshEmbInfo();
    }
  } catch (e) { /* ignore */ }
}

async function startBackfill() {
  if (!confirm('补齐缺失向量：\n\n· 只给 embeddings.db 里没有的桶生成向量，不动已有向量\n· 比「重算全库」省额度，幂等，可反复点\n· 后台运行，期间可正常使用\n\n开始？\n\nBackfill missing embeddings:\n\n· Only generates vectors for buckets missing from embeddings.db; leaves existing ones untouched\n· Cheaper than a full recompute, idempotent, safe to click repeatedly\n· Runs in the background; the app stays usable\n\nStart?')) return;
  var st = document.getElementById('emb-backfill-status');
  var btn = document.getElementById('emb-backfill-btn');
  if (st) st.textContent = '启动中… / Starting…';
  if (window.ObPet) window.ObPet.react('embedding_rebuild');
  try {
    var r = await authFetch('/api/embedding/backfill', { method: 'POST' });
    if (!r) return;
    var d = await readJsonSafe(r);
    if (r.status === 202 && d.ok) {
      if (btn) btn.disabled = true;
      if (_embBackfillPollTimer) return;
      pollBackfillStatus();
      _embBackfillPollTimer = setInterval(pollBackfillStatus, 2000);
    } else {
      if (st) st.innerHTML = '<b style="color:var(--negative,#c33)">启动失败：' + esc(d.error || ('HTTP ' + r.status)) + '</b>';
    }
  } catch (e) {
    if (st) st.innerHTML = '<b style="color:var(--negative,#c33)">请求失败：' + esc(e.message || e) + '</b>';
  }
}

document.addEventListener('click', function(e) {
  if (e.target && e.target.id === 'emb-migrate-btn') {
    var targetBackend = document.getElementById('cfg-emb-backend').value;
    var msg = '即将用「' + targetBackend + '」后端重算所有 bucket 的向量。\n\n'
      + '· 会先备份 embeddings.db → embeddings.db.backup\n'
      + '· 后台跑，每批 10 条间隔 0.5s，期间正常使用\n'
      + '· 切到 api 需先在「向量化 API Key」环境变量里配好 key\n\n'
      + '继续？';
    if (!confirm(msg)) return;
    if (window.ObPet) window.ObPet.react('embedding_rebuild');
    var btn = e.target;
    btn.disabled = true;
    btn.textContent = '启动中… / Starting…';
    var migrationPayload = {
      target_backend: targetBackend,
      api_format: (document.getElementById('cfg-emb-format') || {value:'openai_compat'}).value || 'openai_compat',
      base_url: (document.getElementById('cfg-emb-base-url') || {value:''}).value.trim(),
      model: (document.getElementById('cfg-emb-model') || {value:''}).value.trim()
    };
    fetch(BASE + '/api/embedding/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(migrationPayload)
    }).then(function(r) {
      // 经 readJsonSafe 解析：响应体为空 / 网关 502 HTML（隧道重连、Safari）时
      // 给人话错误，而不是 iOS Safari 那句 "The string did not match the expected pattern."
      return readJsonSafe(r).then(function(d) { return { status: r.status, body: d }; });
    }).then(function(res) {
      btn.disabled = false;
      btn.textContent = '切换 / 重算所有 embedding…';
      if (res.status === 202 && res.body && res.body.ok) {
        _startEmbMigratePolling();
      } else {
        alert('启动失败：' + (res.body && res.body.error || ('HTTP ' + res.status)));
      }
    }).catch(function(err) {
      btn.disabled = false;
      btn.textContent = '切换 / 重算所有 embedding…';
      alert('请求失败：' + err.message);
    });
  }
});

// ---- 本地向量模型 (Ollama / bge-m3) ----
async function loadLocalEmbStatus() {
  var el = document.getElementById('local-emb-status');
  if (!el) return;
  // 1) 环境检测（os/arch/docker/已装/在跑）
  var envD = null;
  try { var er = await authFetch('/api/embedding/local/env'); if (er) envD = await readJsonSafe(er); } catch (e) {}
  var envEl = document.getElementById('local-emb-env');
  if (envEl && envD && envD.ok) {
    var osName = ({windows:'Windows', linux:'Linux', macos:'macOS'})[envD.os] || envD.os;
    envEl.innerHTML = '本机：<b>' + esc(osName) + ' / ' + esc(envD.arch) + '</b>'
      + (envD.in_docker ? ' · <span style="color:var(--warning,#b89962)">Docker 容器</span>' : ' · 原生')
      + ' · 运行时' + (envD.installed ? ('<span style="color:var(--positive,#7EAD68)">已装</span>') : '未装')
      + ' · 服务' + (envD.running ? ('<span style="color:var(--positive,#7EAD68)">在跑</span>') : '未跑');
  }
  // 2) ollama 服务 + 模型状态
  try {
    var r = await authFetch('/api/embedding/local/status?model=bge-m3');
    if (!r) return;
    var d = await readJsonSafe(r);
    if (!d.ok) { el.textContent = '状态读取失败'; return; }
    el.innerHTML =
      'Ollama 服务：' + (d.reachable ? '<b style="color:var(--positive,#7EAD68)">已连接</b>' : '<b style="color:var(--negative)">未连接</b>') +
      ' · <code>' + esc(d.ollama_url || '') + '</code><br>' +
      'bge-m3 模型：' + (d.has_model ? '<b style="color:var(--positive,#7EAD68)">已就绪 ' + _SV.ok + '</b>' : '<b style="color:var(--warning,#b89962)">未下载</b>') +
      (d.models && d.models.length ? '<br><span style="color:var(--text-light)">已装：' + d.models.map(esc).join(', ') + '</span>' : '');
    var hint = document.getElementById('local-emb-hint');
    if (hint) {
      if (envD && envD.in_docker) hint.innerHTML = _SV.warn + ' Docker 部署：启用自带的本地向量化容器 <code>docker compose -f docker-compose.user.yml --profile local up -d</code>（容器内无法给宿主装运行时），起好后回来「下载 bge-m3」→「切本地」。';
      else if (!d.reachable && envD && !envD.installed) hint.innerHTML = _SV.info + ' 还没装本地运行时。点「一键本地化」或「1·安装运行时」自动装（免管理员 / sudo）。';
      else if (!d.reachable) hint.innerHTML = _SV.info + ' 运行时已装但没在跑，点「2·启动」。';
      else hint.textContent = '提示：切换云端↔本地会全库重算（Gemini 3072 维 ↔ bge-m3 1024 维不通用），重算期间检索暂用旧库，不影响使用。';
    }
    if (d.pull && d.pull.running) { _renderLocalPull(d.pull); _startLocalPullPolling(); }
  } catch (e) {
    el.textContent = '状态读取失败：' + (e.message || e);
  }
}

// ---- 本地运行时：安装 / 启动 ----
function _binMirror() {
  var sel = (document.getElementById('local-emb-binmirror') || {}).value || 'official';
  var custom = ((document.getElementById('local-emb-binmirror-custom') || {}).value || '').trim();
  return custom || sel;
}
var _installTimer = null;
function _renderInstall(s) {
  var el = document.getElementById('local-emb-install-status');
  if (!el || !s) return;
  if (s.phase === 'idle') { el.textContent = ''; return; }
  if (s.phase === 'error') {
    el.innerHTML = '<b style="color:var(--negative)">' + _SV.err + ' 安装失败：' + esc(s.error || '') + '</b>'
      + (s.hint ? '<br><span style="color:var(--text-light)">' + esc(s.hint) + '</span>' : '');
    return;
  }
  if (s.phase === 'done') { el.innerHTML = '<b style="color:var(--positive,#7EAD68)">' + _SV.ok + ' 运行时安装完成</b>'; return; }
  var ph = ({ starting:'准备 / Preparing', downloading:'下载中 / Downloading', installing:'安装中 / Installing', extracting:'解压中 / Extracting' })[s.phase] || s.phase;
  el.innerHTML = esc(ph) + (s.percent ? ' · ' + Number(s.percent) + '%' : '') + (s.msg ? ' · ' + esc(s.msg) : '');
}
async function _installAndWait() {
  var el = document.getElementById('local-emb-install-status');
  if (el) el.textContent = '启动安装…';
  var r = await authFetch('/api/embedding/local/install', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mirror: _binMirror() }) });
  if (!r) return { ok:false };
  var d = await readJsonSafe(r);
  if (d.already) { if (el) el.innerHTML = '<b style="color:var(--positive,#7EAD68)">' + _SV.ok + ' 运行时已安装</b>'; return { ok:true }; }
  if (!(r.status === 202 && d.ok)) { if (el) el.innerHTML = '<b style="color:var(--negative)">' + _SV.err + ' ' + esc(d.error || ('HTTP ' + r.status)) + '</b>'; return { ok:false, error:d.error }; }
  return await new Promise(function (resolve) {
    if (_installTimer) clearInterval(_installTimer);
    _installTimer = setInterval(async function () {
      try {
        var sr = await authFetch('/api/embedding/local/install/status');
        if (!sr) return;
        var sd = await readJsonSafe(sr);
        if (!sd.ok) return;
        _renderInstall(sd.install);
        if (sd.install && !sd.install.running) {
          clearInterval(_installTimer); _installTimer = null;
          loadLocalEmbStatus();
          resolve({ ok: sd.install.phase === 'done', error: sd.install.error });
        }
      } catch (e) { /* keep waiting */ }
    }, 1500);
  });
}
async function installOllama() { await _installAndWait(); }
async function startOllama() {
  var el = document.getElementById('local-emb-install-status');
  if (el) el.textContent = '启动 ollama…';
  try {
    var r = await authFetch('/api/embedding/local/start', { method:'POST' });
    if (!r) return false;
    var d = await readJsonSafe(r);
    if (d.ok) { if (el) el.innerHTML = '<b style="color:var(--positive,#7EAD68)">' + _SV.ok + ' ollama 已在跑</b>'; loadLocalEmbStatus(); return true; }
    if (el) el.innerHTML = '<b style="color:var(--negative)">' + _SV.err + ' ' + esc(d.error || '启动失败') + '</b>';
    return false;
  } catch (e) { if (el) el.innerHTML = '<b style="color:var(--negative)">' + _SV.err + ' ' + esc(e.message || e) + '</b>'; return false; }
}

var _localPullTimer = null;
function _renderLocalPull(p) {
  var el = document.getElementById('local-emb-pull-status');
  if (!el || !p) return;
  if ((p.status === 'idle' || !p.status) && !p.running) { el.textContent = ''; return; }
  var txt = '下载 ' + esc(p.model || '') + '：' + esc(p.status || '') + (p.percent ? ' · ' + Number(p.percent) + '%' : '');
  if (p.status === 'success') txt = '<b style="color:var(--positive,#7EAD68)">' + _SV.ok + ' ' + esc(p.model || '') + ' 下载完成</b>';
  if (p.status === 'error') txt = '<b style="color:var(--negative)">' + _SV.err + ' 下载失败：' + esc(p.error || '') + '</b>';
  el.innerHTML = txt;
}
async function _pollLocalPull() {
  try {
    var r = await authFetch('/api/embedding/local/pull/status');
    if (!r) return;
    var d = await readJsonSafe(r);
    if (!d.ok) return;
    _renderLocalPull(d.pull);
    if (d.pull && !d.pull.running) {
      if (_localPullTimer) { clearInterval(_localPullTimer); _localPullTimer = null; }
      loadLocalEmbStatus();
    }
  } catch (e) { /* ignore */ }
}
function _startLocalPullPolling() {
  if (_localPullTimer) return;
  _pollLocalPull();
  _localPullTimer = setInterval(_pollLocalPull, 2000);
}
async function pullLocalModel() {
  var mirror = document.getElementById('local-emb-mirror').value;
  var custom = (document.getElementById('local-emb-mirror-custom').value || '').trim();
  var body = { model: 'bge-m3', mirror: custom || mirror };
  var el = document.getElementById('local-emb-pull-status');
  if (el) el.textContent = '启动下载…';
  try {
    var r = await authFetch('/api/embedding/local/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r) return;
    var d = await readJsonSafe(r);
    if (!d.ok) { if (el) el.innerHTML = '<b style="color:var(--negative)">' + _SV.err + ' ' + esc(d.error || '启动失败') + '</b>'; return; }
    _startLocalPullPolling();
  } catch (e) {
    if (el) el.innerHTML = '<b style="color:var(--negative)">' + _SV.err + ' ' + esc(e.message || e) + '</b>';
  }
}
async function switchEmbedding(mode, skipConfirm) {
  var payload, label;
  if (mode === 'ollama') {
    payload = { target_backend: 'ollama', api_format: 'ollama', model: 'bge-m3', base_url: '' };
    label = '本地 bge-m3';
  } else {
    payload = { target_backend: 'gemini', api_format: 'gemini', model: 'gemini-embedding-001', base_url: '' };
    label = '云端 Gemini';
  }
  if (!skipConfirm && !confirm('即将切换到「' + label + '」并重算全库向量。\n\n· 后台运行，期间可正常使用（检索暂用旧库）\n· Gemini 3072 维 ↔ bge-m3 1024 维不通用，必须重算\n· 切到本地前请确认 bge-m3 已下载\n\n继续？')) return;
  var st = document.getElementById('emb-migrate-status');
  if (st) st.textContent = '启动中… / Starting…';
  try {
    var r = await authFetch('/api/embedding/migrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!r) return;
    var d = await readJsonSafe(r);
    if (r.status === 202 && d.ok) {
      _startEmbMigratePolling();
    } else {
      alert('启动失败：' + (d.error || ('HTTP ' + r.status)));
    }
  } catch (e) {
    alert('请求失败：' + (e.message || e));
  }
}

// ===== 服务商预设：选一下自动填好 base_url + 正确的 model 名 =====
// 参考酒馆：先选「用哪个」，字段自动长出来；从根上消灭「填错 model 名 400」那类坑。
// 只填现有字段；保存时会把 format/base_url/model 作为一个完整 provider 配置提交。
var EMBED_PRESETS = {
  gemini:      { format: 'openai_compat', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-embedding-001' },
  siliconflow: { format: 'openai_compat', base_url: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
  ollama:      { format: 'ollama',        base_url: '', model: 'bge-m3' },
  custom:      { format: 'openai_compat', base_url: '', model: '' }
};
var DEHY_PRESETS = {
  deepseek:    { format: 'openai_compat', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  gemini:      { format: 'openai_compat', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash-lite' },
  siliconflow: { format: 'openai_compat', base_url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  anthropic:   { format: 'anthropic',     base_url: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest' },
  custom:      { format: 'openai_compat', base_url: '', model: '' }
};
function _setVal(id, v) { var el = document.getElementById(id); if (el != null) el.value = v; }
function applyEmbedPreset() {
  var k = (document.getElementById('emb-preset') || {}).value || '';
  var p = EMBED_PRESETS[k]; if (!p) return;
  _setVal('cfg-emb-format', p.format);
  _setVal('cfg-emb-base-url', p.base_url);
  _setVal('cfg-emb-model', p.model);
  if (k === 'ollama') _setVal('cfg-emb-enabled', 'true');
  if (typeof onEmbFormatChange === 'function') onEmbFormatChange();
  var hint = document.getElementById('emb-preset-hint');
  if (hint) hint.textContent = (k === 'ollama')
    ? '本地模式：填好了 bge-m3。无需 key —— 用下方「一键本地化」装+起+下模型，或已起 ollama 就直接「保存」。'
    : '已自动填好 Base URL + 模型名，填入对应 key 点「保存」再「测试」即可。';
}
function applyDehyPreset() {
  var k = (document.getElementById('dehy-preset') || {}).value || '';
  var p = DEHY_PRESETS[k]; if (!p) return;
  _setVal('cfg-dehy-format', p.format);
  _setVal('cfg-dehy-url', p.base_url);
  _setVal('cfg-dehy-model', p.model);
  if (typeof onDehyFormatChange === 'function') onDehyFormatChange();
  var hint = document.getElementById('dehy-preset-hint');
  if (hint) hint.textContent = '已自动填好 Base URL + 模型名，填入对应 key 点「保存」再「测试」即可。';
}

// 一键本地化：检测系统 → 装运行时（免提权）→ 起子进程 → 下模型 → 切本地重算
async function oneClickLocal() {
  var er = await authFetch('/api/embedding/local/env');
  if (!er) return;
  var env = await readJsonSafe(er);
  if (!env || !env.ok) { alert('环境检测失败，请稍后重试。 / Environment check failed, please retry later.'); return; }
  if (env.in_docker) {
    alert('检测到 OB 运行在 Docker 容器里。\n\n本地向量化请启用自带的 ollama 容器（容器内无法给宿主装运行时）：\n\n  docker compose -f docker-compose.user.yml --profile local up -d\n\n起好后回来：「下载 bge-m3」→「切本地」即可。\n\nDetected OB is running inside a Docker container.\n\nFor local embeddings, enable the bundled ollama container (a container cannot install a runtime onto the host):\n\n  docker compose -f docker-compose.user.yml --profile local up -d\n\nOnce it is up, come back and click "Download bge-m3" → "Switch to local".');
    return;
  }
  var osName = ({ windows:'Windows', linux:'Linux', macos:'macOS' })[env.os] || env.os;
  if (!confirm('一键本地化（检测到：' + osName + ' / ' + env.arch + '）：\n\n· 自动安装 Ollama 运行时（免管理员 / sudo；Win/Linux 约 1.4GB，含 GPU 库）\n· 作为 OB 子进程常驻（OB 在它就在）\n· 下载 bge-m3 模型（约 1.2GB，需 2–3GB 空闲内存）\n· 切到本地并全库重算（期间可正常用）\n\n首次合计需下载约 2–3GB，请确保磁盘/网络够。开始？')) return;

  // 1) 安装运行时
  if (!env.installed) {
    var ins = await _installAndWait();
    if (!ins.ok) { alert('运行时安装未完成，已停在这一步。\n可在「运行时镜像」换成 GitHub 源重试，或按下方提示手动安装后再点一次。\n\nRuntime install did not complete, stopped at this step.\nTry switching "Runtime mirror" to the GitHub source, or follow the instructions below to install manually and click again.'); return; }
  }
  // 2) 启动（子进程常驻）
  if (!env.running) {
    var started = await startOllama();
    if (!started) { alert('Ollama 启动失败，已停在这一步。 / Ollama failed to start, stopped at this step.'); return; }
  }
  // 3) 缺模型则下载
  var sr = await authFetch('/api/embedding/local/status?model=bge-m3');
  var sd = sr ? await readJsonSafe(sr) : null;
  if (!sd || !sd.has_model) {
    var pmsg = document.getElementById('local-emb-pull-status');
    if (pmsg) pmsg.textContent = '开始下载 bge-m3（约 1.2GB）…';
    await pullLocalModel();
    var ok = await _waitLocalPull();
    if (!ok) { alert('模型下载未成功，已中止（未改动现有向量）。可在「模型镜像」换 ModelScope 重试。\n\nModel download did not succeed, aborted (existing vectors untouched). Try switching "Model mirror" to ModelScope.'); return; }
  }
  // 4) 切到本地并重算
  await switchEmbedding('ollama', true);
}
// 等待拉取完成；true=成功
function _waitLocalPull() {
  return new Promise(function (resolve) {
    var waited = 0;
    var iv = setInterval(async function () {
      waited += 2;
      try {
        var r = await authFetch('/api/embedding/local/pull/status');
        if (r) {
          var d = await readJsonSafe(r);
          var p = (d && d.pull) || {};
          if (!p.running) { clearInterval(iv); resolve(p.status === 'success'); return; }
        }
      } catch (e) { /* keep waiting */ }
      if (waited > 1800) { clearInterval(iv); resolve(false); }  // 30min 上限
    }, 2000);
  });
}

// ---- GitHub 同步 ----
async function loadGithubStatus() {
  try {
    var res = await authFetch('/api/github/status');
    if (!res || !res.ok) return;
    var d = await res.json();
    // 非敏感字段回填 value，不只写 placeholder。否则页面刷新/标签页
    // 被浏览器回收后表单看起来「全被清空」，再次保存还强制重填 repo。
    var tokenEl = document.getElementById('gh-token');
    var repoEl = document.getElementById('gh-repo');
    var branchEl = document.getElementById('gh-branch');
    var prefixEl = document.getElementById('gh-prefix');
    if (repoEl && d.repo !== undefined) repoEl.value = d.repo || '';
    if (branchEl && d.branch !== undefined) branchEl.value = d.branch || 'main';
    if (prefixEl && d.path_prefix !== undefined) prefixEl.value = d.path_prefix || '';
    if (tokenEl) tokenEl.placeholder = d.token_set
      ? '已配置（留空 = 保留现有 Token）'
      : 'ghp_xxxx…（Fine-grained 或 Classic，需 repo 权限）';
    var autoMin = d.auto_interval_minutes || 0;
    var ghIntervalEl = document.getElementById('gh-interval');
    if (ghIntervalEl) ghIntervalEl.value = String(autoMin);
    var box = document.getElementById('gh-status-box');
    if (box) box.style.display = d.configured ? '' : 'none';
    if (d.configured && box) {
      document.getElementById('gh-st-repo').textContent = d.repo || '—';
      document.getElementById('gh-st-branch').textContent = d.branch || '—';
      document.getElementById('gh-st-prefix').textContent = d.path_prefix || '（根目录）';
      var intervalLabels = {0:'关闭', 30:'每 30 分钟', 60:'每 1 小时', 360:'每 6 小时', 720:'每 12 小时', 1440:'每 24 小时'};
      document.getElementById('gh-st-interval').textContent = intervalLabels[autoMin] || (autoMin > 0 ? '每 ' + autoMin + ' 分钟' : '关闭');
      document.getElementById('gh-st-time').textContent = d.last_sync ? new Date(d.last_sync).toLocaleString() : '从未';
      document.getElementById('gh-st-status').innerHTML = ({idle:'待机', ok: _SV.ok+' 成功', error: _SV.err+' 失败'})[d.last_status] || esc(d.last_status);
      var errRow = document.getElementById('gh-st-error-row');
      if (d.last_error) {
        errRow.style.display = '';
        document.getElementById('gh-st-error').textContent = d.last_error;
      } else { errRow.style.display = 'none'; }
    }
  } catch(e) {
    var m = document.getElementById('gh-msg');
    if (m) { m.style.color = 'var(--negative)'; m.textContent = '加载 GitHub 状态失败: ' + (e.message || e); }
  }
}

async function saveGithubConfig() {
  var msg = document.getElementById('gh-msg');
  var token = (document.getElementById('gh-token').value || '').trim();
  var repo = (document.getElementById('gh-repo').value || '').trim();
  var branch = (document.getElementById('gh-branch').value || '').trim() || 'main';
  var prefix = (document.getElementById('gh-prefix').value || '').trim();
  var autoInterval = parseInt(document.getElementById('gh-interval').value || '0', 10);
  if (!repo) { msg.innerHTML = _SV.warn + ' 请填写仓库名（owner/repo）'; msg.style.color = 'var(--accent)'; return; }
  msg.textContent = '保存中… / Saving…'; msg.style.color = '';
  try {
    var res = await authFetch('/api/github/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token, repo, branch, path_prefix: prefix, auto_interval_minutes: autoInterval}),
    });
    var d = await readJsonSafe(res);
    if (d.ok) {
      msg.innerHTML = _SV.ok + ' 配置已保存';
      msg.style.color = 'var(--success, green)';
      document.getElementById('gh-token').value = '';
      await loadGithubStatus();
    } else {
      msg.innerHTML = _SV.err + ' ' + esc(d.error || '保存失败');
      msg.style.color = 'var(--accent)';
    }
  } catch(e) { msg.innerHTML = _SV.err + ' ' + esc(e.message || '网络错误'); msg.style.color = 'var(--negative)'; }
}

async function validateGithub() {
  var msg = document.getElementById('gh-msg');
  msg.textContent = '验证中… / Verifying…'; msg.style.color = '';
  try {
    var res = await authFetch('/api/github/validate', {method: 'POST'});
    var d = await readJsonSafe(res);
    if (d.ok) {
      msg.innerHTML = _SV.ok + ' 连接成功：' + esc(d.repo_full_name) + (d.private ? '（私有）' : '（公开）');
      msg.style.color = 'var(--success, green)';
    } else {
      msg.innerHTML = _SV.err + ' ' + esc(d.error || '验证失败');
      msg.style.color = 'var(--accent)';
    }
  } catch(e) { msg.innerHTML = _SV.err + ' ' + esc(e.message || '网络错误'); msg.style.color = 'var(--negative)'; }
}

async function runGithubSync() {
  var msg = document.getElementById('gh-msg');
  var btn = document.getElementById('gh-sync-btn');
  btn.disabled = true; btn.textContent = '同步中… / Syncing…';
  msg.textContent = '正在上传 bucket 文件到 GitHub…'; msg.style.color = '';
  try {
    var res = await authFetch('/api/github/sync', {method: 'POST'});
    var d = await readJsonSafe(res);
    if (d.ok) {
      msg.innerHTML = _SV.ok + ' 同步完成，上传 ' + d.uploaded + ' 个文件';
      msg.style.color = 'var(--success, green)';
      await loadGithubStatus();
    } else {
      msg.innerHTML = _SV.err + ' ' + esc(d.error || '同步失败');
      msg.style.color = 'var(--accent)';
    }
  } catch(e) { msg.innerHTML = _SV.err + ' ' + esc(e.message || '网络错误'); msg.style.color = 'var(--negative)'; }
  btn.disabled = false; btn.textContent = '立即同步 ↑';
}

// 从 GitHub 导入/恢复（会覆盖本地同名记忆）→ 导入后自动重建向量
async function runGithubImport(force) {
  var msg = document.getElementById('gh-msg');
  var btn = document.getElementById('gh-import-btn');
  if (!force && !confirm('从 GitHub 把记忆拉回本地。\n\n同名记忆会被 GitHub 上的版本覆盖，本地独有的记忆保留不动。\n导入前会自动存一份本地备份，万一不对可以退回。\n\n继续吗？\n\nImport memories back from GitHub.\n\nMemories with the same name will be overwritten by the GitHub version; local-only memories stay untouched.\nA local backup is taken automatically before import, so you can roll back if needed.\n\nContinue?')) return;
  if (btn) { btn.disabled = true; }
  msg.textContent = '正在从 GitHub 拉回记忆…（已先备份本地）'; msg.style.color = '';
  try {
    var res = await authFetch('/api/github/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!force }),
    });
    var d = await readJsonSafe(res);
    if (d.ok) {
      var restoredBuckets = Number.isInteger(d.buckets_imported) ? d.buckets_imported : (d.imported || 0);
      var restoredSources = Number.isInteger(d.sources_imported) && d.sources_imported > 0
        ? '，安装 ' + d.sources_imported + ' 份原文证据' : '';
      var extra = (d.skipped ? '，跳过 ' + d.skipped : '') + (d.truncated ? '（⚠️ 仓库文件过多被截断，部分未导入）' : '');
      msg.innerHTML = _SV.ok + ' 导入完成：恢复 ' + restoredBuckets + ' 条记忆' + restoredSources + extra
        + (d.pre_import_backup ? '<br><span style="color:var(--text-light)">本地备份：<code>' + esc(d.pre_import_backup) + '</code></span>' : '')
        + (d.integrity_warning ? '<br><span style="color:var(--negative)">' + _SV.warn + ' ' + esc(d.integrity_warning) + '</span>' : '');
      msg.style.color = d.integrity_warning ? 'var(--accent)' : 'var(--success, green)';
      // 导入后自动重建向量（恢复的桶 embeddings.db 里还没有）
      if (typeof startBackfill === 'function') {
        msg.innerHTML += '<br>正在为恢复的记忆重建向量索引…';
        try { await _runBackfillSilent(); msg.innerHTML += ' ' + _SV.ok; } catch(e){}
      }
      await loadGithubStatus();
      if (typeof loadStatus === 'function') loadStatus();
    } else if (d.backup_failed) {
      // 备份没成功 → 后端已拦下，未动本地记忆。让用户决定要不要冒险强制导入。
      msg.innerHTML = _SV.err + ' ' + esc(d.error || '备份失败，已取消导入');
      msg.style.color = 'var(--accent)';
      if (btn) { btn.disabled = false; }
      if (confirm('导入前的本地备份没做成功，所以这次没有「后悔药」。\n\n仍要强制从 GitHub 覆盖本地同名记忆吗？（覆盖后无法找回）\n\nThe pre-import local backup did not succeed, so there is no safety net this time.\n\nForce-overwrite local memories with the same name from GitHub anyway? (cannot be undone)')) {
        return runGithubImport(true);
      }
      return;
    } else {
      msg.innerHTML = _SV.err + ' ' + esc(d.error || '导入失败');
      msg.style.color = 'var(--accent)';
    }
  } catch(e) { msg.innerHTML = _SV.err + ' ' + esc(e.message || '网络错误'); msg.style.color = 'var(--negative)'; }
  if (btn) { btn.disabled = false; }
}
// 静默跑一次 backfill 并等完成（导入后重建向量用）
async function _runBackfillSilent() {
  var r = await authFetch('/api/embedding/backfill', { method: 'POST' });
  if (!r) return;
  var d = await readJsonSafe(r);
  if (!(r.status === 202 && d.ok)) return;
  await new Promise(function (resolve) {
    var iv = setInterval(async function () {
      try {
        var sr = await authFetch('/api/embedding/backfill/status');
        if (!sr) return;
        var sd = await readJsonSafe(sr);
        if (sd && sd.backfill && !sd.backfill.running) { clearInterval(iv); resolve(); }
      } catch (e) {}
    }, 1500);
    setTimeout(function () { clearInterval(iv); resolve(); }, 180000);
  });
}

// 记忆归属徽标。规则：owner_count>=2 才显示（单人不打扰），文字取 owner_name。
// 接受一个可选的已解析 cfg，避免重复请求；无则自行拉一次 /api/config。
async function loadOwnerBadge(cfg) {
  try {
    if (!cfg) {
      var res = await authFetch('/api/config');
      if (!res) return;
      cfg = await res.json();
    }
    var badge = document.getElementById('owner-badge');
    if (!badge) return;
    var count = parseInt(cfg.owner_count, 10) || 1;
    var name = (cfg.owner_name || '').trim();
    if (count >= 2 && name) {
      document.getElementById('owner-badge-text').textContent = name;
      badge.style.display = 'inline-flex';
      if (window.lucide) lucide.createIcons();
    } else {
      badge.style.display = 'none';
    }
  } catch (e) { /* ignore：徽标是锦上添花，失败不影响主流程 */ }
}

async function loadConfig() {
  try {
    var res = await authFetch('/api/config');
    if (!res) return;
    var cfg = await res.json();
    loadOwnerBadge(cfg);
    document.getElementById('cfg-dehy-model').value = cfg.dehydration.model || '';
    document.getElementById('cfg-dehy-url').value = cfg.dehydration.base_url || '';
    var fmtEl = document.getElementById('cfg-dehy-format');
    if (fmtEl) { fmtEl.value = cfg.dehydration.api_format || 'openai_compat'; onDehyFormatChange(); }
    var dehyNotice = document.getElementById('dehy-key-notice');
    if (dehyNotice) dehyNotice.style.display = cfg.dehydration.api_key_masked ? 'none' : '';
    document.getElementById('cfg-dehy-maxtokens').value = cfg.dehydration.max_tokens || 1024;
    document.getElementById('cfg-dehy-temp').value = cfg.dehydration.temperature != null
      ? cfg.dehydration.temperature : 0.1;
    document.getElementById('cfg-emb-enabled').value = cfg.embedding.enabled ? 'true' : 'false';
    document.getElementById('cfg-emb-model').value = cfg.embedding.model || '';
    var embFmtEl = document.getElementById('cfg-emb-format');
    if (embFmtEl) { embFmtEl.value = cfg.embedding.api_format || 'openai_compat'; onEmbFormatChange(); }
    var backendSel = document.getElementById('cfg-emb-backend');
    backendSel.value = cfg.embedding.backend || 'local';
    var noteEl = document.getElementById('cfg-emb-backend-note');
    var opts = (cfg.embedding.backend_options || []);
    function renderNote() {
      var match = opts.find(function(o) { return o.value === backendSel.value; });
      noteEl.textContent = match ? match.note : '';
    }
    renderNote();
    backendSel.onchange = renderNote;
    // 加载当前 embedding 后端摘要 + 启动迁移轮询（只刷一次摘要，迁移状态独立轮询）
    refreshEmbInfo();
    refreshEnvConfig();
    document.getElementById('cfg-merge').value = cfg.merge_threshold != null
      ? cfg.merge_threshold : 75;
    var mcpAuthEl = document.getElementById('cfg-mcp-auth');
    if (mcpAuthEl) {
      const configuredAuthMode = ['oauth', 'token', 'hybrid'].includes(cfg.mcp_auth_mode)
        ? cfg.mcp_auth_mode : 'oauth';
      mcpAuthEl.value = cfg.mcp_require_auth ? configuredAuthMode : 'off';
    }
    window._mcpTokenConfigured = !!cfg.mcp_token_configured;
    window._mcpTokenHint = cfg.mcp_token_hint || null;
    onMcpAuthModeChange();
    var mcpNetwork = cfg.mcp_network_security || {};
    var mcpAuthMsg = document.getElementById('mcp-auth-msg');
    if (mcpAuthMsg && mcpNetwork.guard_active) {
      mcpAuthMsg.style.color = 'var(--warning)';
      mcpAuthMsg.textContent = '当前配置或环境变量请求关闭鉴权；当前生效：安全门禁已强制开启鉴权。'
        + (mcpNetwork.reason ? ' 原因：' + mcpNetwork.reason : '');
    } else if (mcpAuthMsg && mcpNetwork.override_active) {
      mcpAuthMsg.style.color = 'var(--negative)';
      mcpAuthMsg.textContent = '高风险：已显式允许非回环免鉴权。'
        + (mcpNetwork.reason ? ' ' + mcpNetwork.reason : '')
        + (mcpNetwork.auth_environment_override
          ? ' OMBRE_MCP_REQUIRE_AUTH 仍由平台环境变量控制。' : '');
    } else if (mcpAuthMsg) {
      mcpAuthMsg.textContent = '';
    }
    const publicUrl = String((cfg.deployment || {}).public_url || '');
    const publicMode = document.querySelector('input[name="mcp-mode"][value="public"]');
    const localMode = document.querySelector('input[name="mcp-mode"][value="local"]');
    const publicUrlInput = document.getElementById('mcp-custom-domain');
    if (publicUrlInput) publicUrlInput.value = publicUrl;
    if (publicUrl && publicMode) publicMode.checked = true;
    else if (localMode) localMode.checked = true;
    onMcpModeChange();
    setRestartRequired(!!cfg.restart_required, 'MCP 鉴权设置已保存');
    var portEl = document.getElementById('cfg-host-port');
    if (portEl) portEl.value = cfg.host_port || '';
    var portHint = document.getElementById('host-port-hint');
    if (portHint) {
      portHint.innerHTML = cfg.in_docker
        ? 'Docker 部署：容器内端口固定，对外端口由 host 映射决定。保存后请在宿主跑 <code>OMBRE_HOST_PORT=端口 docker compose -f deploy/docker-compose.yml up -d</code>（或 <code>bash deploy/deploy.sh</code>）重建生效。'
        : '裸机部署：保存后<b>重启服务</b>即监听新端口（留空=默认 18001）。';
    }
    var sf = cfg.surfacing || {};
    document.getElementById('cfg-sf-breath-results').value = sf.breath_max_results || 20;
    document.getElementById('cfg-sf-breath-tokens').value = sf.breath_max_tokens || 10000;
    document.getElementById('cfg-sf-feel-tokens').value = sf.feel_max_tokens || 6000;
    document.getElementById('config-readonly').innerHTML =
      'Transport（已保存）: <strong>' + esc(cfg.transport) + '</strong>'
      + '<br>Transport（当前生效）: <strong>' + esc(cfg.transport_effective || cfg.transport) + '</strong>'
      + '<br>数据目录: <strong>' + esc(cfg.buckets_dir) + '</strong>'
      + '<br>运行环境: <strong>' + (cfg.in_docker ? 'Docker 容器' : '裸机') + '</strong>'
      + '<br>对外端口: <strong>' + esc(cfg.host_port || '18001（默认）') + '</strong>';
    if (cfg.transport) highlightTransport(cfg.transport);
  } catch (e) {
    document.getElementById('config-status').innerHTML =
      '<span style="color:var(--negative)">加载失败: ' + esc(e.message) + '</span>';
  }
}

async function refreshEnvConfig() {
  try {
    var r = await authFetch('/api/env-config');
    if (!r) return;
    var d = await readJsonSafe(r);
    if (!d || !d.ok) return;
    var f = d.fields || {};
    var el;
    // Identity
    el = document.getElementById('env-ai-name');
    if (el) el.value = (f['AI_NAME'] || {}).value || '';
    // Compress
    el = document.getElementById('env-compress-key');
    if (el) { el.placeholder = f['OMBRE_COMPRESS_API_KEY'] && f['OMBRE_COMPRESS_API_KEY'].is_set ? '当前：' + (f['OMBRE_COMPRESS_API_KEY'].value || '***') + '（留空 = 不修改）' : '未设置'; el.value = ''; }
    el = document.getElementById('env-compress-base');
    if (el) el.value = (f['OMBRE_COMPRESS_BASE_URL'] || {}).value || '';
    el = document.getElementById('env-compress-model');
    if (el) el.value = (f['OMBRE_COMPRESS_MODEL'] || {}).value || '';
    el = document.getElementById('env-compress-format');
    if (el) el.value = (f['OMBRE_COMPRESS_FORMAT'] || {}).value || 'openai_compat';
    el = document.getElementById('env-compress-timeout');
    if (el) el.value = (f['OMBRE_COMPRESS_TIMEOUT_SECONDS'] || {}).value || '';
    // Embed
    el = document.getElementById('env-embed-key');
    if (el) { el.placeholder = f['OMBRE_EMBED_API_KEY'] && f['OMBRE_EMBED_API_KEY'].is_set ? '当前：' + (f['OMBRE_EMBED_API_KEY'].value || '***') + '（留空 = 不修改）' : '未设置'; el.value = ''; }
    el = document.getElementById('env-embed-base');
    if (el) el.value = (f['OMBRE_EMBED_BASE_URL'] || {}).value || '';
    // 同步引擎区域内联 key 输入框 placeholder
    var embKeyInline = document.getElementById('cfg-emb-api-key');
    if (embKeyInline) {
      embKeyInline.placeholder = f['OMBRE_EMBED_API_KEY'] && f['OMBRE_EMBED_API_KEY'].is_set ? '当前: ' + (f['OMBRE_EMBED_API_KEY'].value || '***') : '未设置';
      embKeyInline.value = '';
    }
    var embBaseInline = document.getElementById('cfg-emb-base-url');
    if (embBaseInline) embBaseInline.value = (f['OMBRE_EMBED_BASE_URL'] || {}).value || '';
    var compKeyInline = document.getElementById('cfg-dehy-key');
    if (compKeyInline) {
      compKeyInline.placeholder = f['OMBRE_COMPRESS_API_KEY'] && f['OMBRE_COMPRESS_API_KEY'].is_set ? '当前: ' + (f['OMBRE_COMPRESS_API_KEY'].value || '***') : '未设置';
    }
    el = document.getElementById('env-embed-model');
    if (el) el.value = (f['OMBRE_EMBED_MODEL'] || {}).value || '';
    el = document.getElementById('env-embed-timeout');
    if (el) el.value = (f['OMBRE_EMBED_TIMEOUT_SECONDS'] || {}).value || '';
    // Webhook
    el = document.getElementById('env-hook-url');
    if (el) el.value = (f['OMBRE_HOOK_URL'] || {}).value || '';
    el = document.getElementById('env-hook-skip');
    if (el) { var skipVal = (f['OMBRE_HOOK_SKIP'] || {}).value || ''; el.value = (skipVal === 'true' || skipVal === '1' || skipVal === 'yes') ? 'true' : ''; }
    // 平台 env 覆盖告警：检查哪些字段由启动期平台 env 注入（from_boot），
    // 它们的优先级高于 config.yaml，重启会盖回——dashboard 在这里永远赢不了。
    refreshEnvShadowWarning();
  } catch (e) {
    // 不再静默吞掉：把失败显示在状态行 + 用 placeholder 提示，避免 key 框卡在「加载中…」
    var st = document.getElementById('env-config-status');
    if (st) { st.style.color = 'var(--negative)'; st.textContent = '配置加载失败：' + (e && e.message ? e.message : e); }
    ['env-compress-key', 'env-embed-key', 'cfg-emb-api-key', 'cfg-dehy-key'].forEach(function (id) {
      var el2 = document.getElementById(id);
      if (el2 && (!el2.placeholder || el2.placeholder.indexOf('加载') !== -1)) el2.placeholder = '（加载失败，请重试）';
    });
  }
}

// 检测「被平台环境变量接管」的字段并红字告警。
// 数据源 /api/env-vars 的 from_boot=true ⇒ 该 env 在进程启动那一刻就由平台注入，
// 优先级高于 config.yaml / .env；dashboard 保存的同名值会在下次重启被它覆盖。
// （注意：dashboard 保存当下也会写 os.environ，故必须用 from_boot 而非 set 来判定，
//  否则保存后会误报。）
async function refreshEnvShadowWarning() {
  var box = document.getElementById('env-shadow-warning');
  if (!box) return;
  var LABELS = {
    AI_NAME: 'AI 显示名',
    OMBRE_COMPRESS_BASE_URL: '压缩 Base URL',
    OMBRE_COMPRESS_MODEL: '压缩 Model',
    OMBRE_COMPRESS_API_KEY: '压缩 API Key',
    OMBRE_COMPRESS_TIMEOUT_SECONDS: '压缩 Timeout',
    OMBRE_EMBED_BASE_URL: '向量化 Base URL',
    OMBRE_EMBED_MODEL: '向量化 Model',
    OMBRE_EMBED_API_KEY: '向量化 API Key',
    OMBRE_EMBED_TIMEOUT_SECONDS: '向量化 Timeout',
    OMBRE_MCP_REQUIRE_AUTH: 'MCP 鉴权开关',
  };
  try {
    var r = await authFetch('/api/env-vars');
    if (!r) return;
    var d = await readJsonSafe(r);
    if (!d || !d.vars) return;
    var shadowed = d.vars.filter(function (v) { return v.from_boot && LABELS[v.name]; });
    if (!shadowed.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var items = shadowed.map(function (v) {
      return '<code>' + v.name + '</code>（' + LABELS[v.name] + '）';
    }).join('、');
    // 分级：一句话结论 → 框住的变量清单（二级条目）→ 分点说明。不再一坨粘在一起。
    box.innerHTML =
      '<strong>⚠ 这些字段由启动环境变量接管，在此保存的值下次重启会被覆盖。</strong>' +
      '<div style="margin:8px 0;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;line-height:1.9;">'
        + items +
      '</div>' +
      '<div style="line-height:1.8;">' +
        '1. 它们的优先级高于 <code>config.yaml</code> 和此面板。<br>' +
        '2. 即便这里改成别的服务商并保存生效，下次重启仍会被启动 env 打回。<br>' +
        '3. 彻底解决：从 <code>docker run -e</code> / compose 的 <code>environment</code> 里<strong>删除上述变量</strong>，让此面板成为唯一来源。' +
      '</div>';
    box.style.display = 'block';
  } catch (e) { /* 告警是增益信息，失败就静默不挡主流程 */ }
}

async function saveEnvConfig() {
  var statusEl = document.getElementById('env-config-status');
  statusEl.textContent = '保存中… / Saving…';
  var updates = {};
  // Identity
  var aiName = document.getElementById('env-ai-name').value.trim();
  updates['AI_NAME'] = aiName;
  // Compress
  var key = document.getElementById('env-compress-key').value.trim();
  if (key) updates['OMBRE_COMPRESS_API_KEY'] = key;
  var base = document.getElementById('env-compress-base').value.trim();
  if (base !== undefined) updates['OMBRE_COMPRESS_BASE_URL'] = base;
  var model = document.getElementById('env-compress-model').value.trim();
  if (model !== undefined) updates['OMBRE_COMPRESS_MODEL'] = model;
  var fmt = (document.getElementById('env-compress-format') || {value:''}).value;
  if (fmt) updates['OMBRE_COMPRESS_FORMAT'] = fmt;
  var timeout = (document.getElementById('env-compress-timeout') || {value:''}).value.trim();
  updates['OMBRE_COMPRESS_TIMEOUT_SECONDS'] = timeout;
  // Embed
  var ekey = document.getElementById('env-embed-key').value.trim();
  if (ekey) updates['OMBRE_EMBED_API_KEY'] = ekey;
  var ebase = document.getElementById('env-embed-base').value.trim();
  if (ebase !== undefined) updates['OMBRE_EMBED_BASE_URL'] = ebase;
  var emodel = document.getElementById('env-embed-model').value.trim();
  if (emodel !== undefined) updates['OMBRE_EMBED_MODEL'] = emodel;
  var etimeout = (document.getElementById('env-embed-timeout') || {value:''}).value.trim();
  updates['OMBRE_EMBED_TIMEOUT_SECONDS'] = etimeout;
  // Webhook
  var hookUrl = document.getElementById('env-hook-url').value.trim();
  updates['OMBRE_HOOK_URL'] = hookUrl;
  var hookSkip = document.getElementById('env-hook-skip').value;
  updates['OMBRE_HOOK_SKIP'] = hookSkip === 'true' ? 'true' : '';

  // 过滤掉所有 undefined（非输入字段的）
  Object.keys(updates).forEach(function(k) { if (updates[k] === undefined) delete updates[k]; });

  try {
    var r = await authFetch('/api/env-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: updates })
    });
    if (!r) return;
    var d = await readJsonSafe(r);
    if (d && d.ok) {
      statusEl.innerHTML = '<span style="color:var(--positive,#7EAD68)">' + _SV.ok + ' 已保存：' + esc((d.updated || []).join(', ')) + (d.warnings && d.warnings.length ? '<br><span style="color:var(--negative)">' + esc(d.warnings.join('; ')) + '</span>' : '') + '</span>';
      refreshEnvConfig();  // 刷新显示新的脱敏值
    } else {
      statusEl.innerHTML = '<span style="color:var(--negative)">保存失败：' + esc(d && d.error ? d.error : '未知错误') + '</span>';
    }
  } catch (e) {
    statusEl.innerHTML = '<span style="color:var(--negative)">请求失败：' + esc(e.message) + '</span>';
  }
}

async function _saveEnvKeys(updates, msgElId) {
  var msgEl = document.getElementById(msgElId);
  if (msgEl) msgEl.textContent = '保存中… / Saving…';
  var requestedKeys = Object.keys(updates || {});
  try {
    var r = await authFetch('/api/env-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: updates })
    });
    if (!r) return;
    var d = await readJsonSafe(r);
    var updatedKeys = d && Array.isArray(d.updated) ? d.updated : [];
    var persistedKeys = d && Array.isArray(d.persisted) ? d.persisted : null;
    var warnings = d && Array.isArray(d.warnings) ? d.warnings.filter(function (item) {
      return item !== null && item !== undefined && String(item).trim();
    }).map(function (item) { return String(item); }) : [];
    var savedKeys = requestedKeys.filter(function (key) { return updatedKeys.indexOf(key) !== -1; });
    var missingKeys = requestedKeys.filter(function (key) { return updatedKeys.indexOf(key) === -1; });
    var unpersistedKeys = persistedKeys === null ? [] : savedKeys.filter(function (key) {
      return persistedKeys.indexOf(key) === -1;
    });
    var responsePartial = !!(d && d.partial);
    var responseFailed = !r.ok || !d || !d.ok;

    if (responseFailed && savedKeys.length === 0) {
      var httpLabel = !r.ok ? '（HTTP ' + r.status + '）' : '';
      var reason = d && d.error
        ? d.error
        : (warnings.length ? warnings.join('; ') : (!r.ok ? '服务器拒绝保存' : '未知错误'));
      if (msgEl) msgEl.innerHTML = '<span style="color:var(--negative)">' + _SV.err + ' 保存失败 / Save failed' + httpLabel + '：' + esc(reason) + '</span>';
      return;
    }

    if (!responseFailed && !responsePartial && missingKeys.length === 0 && unpersistedKeys.length === 0 && warnings.length === 0) {
      if (msgEl) msgEl.innerHTML = '<span style="color:var(--positive,#7EAD68)">' + _SV.ok + ' 已保存 / Saved</span>';
    } else if (savedKeys.length > 0) {
      var partialDetails = [];
      if (missingKeys.length) partialDetails.push('未保存 / Not saved: ' + missingKeys.join(', '));
      if (unpersistedKeys.length) partialDetails.push('未持久化 / Not persisted: ' + unpersistedKeys.join(', '));
      if (warnings.length) partialDetails.push('警告 / Warning: ' + warnings.join('; '));
      if (d && d.error) partialDetails.push(d.error);
      if (!partialDetails.length) partialDetails.push((d && d.note) || '服务器报告部分保存 / Server reported a partial save');
      if (msgEl) msgEl.innerHTML = '<span style="color:var(--warning,#B89762)">' + _SV.warn + ' 部分保存 / Partially saved<br>' + esc(partialDetails.join('\n')).replace(/\n/g, '<br>') + '</span>';
    } else {
      var failureDetails = warnings.length
        ? warnings.join('; ')
        : '服务器未确认任何请求字段 / Server did not confirm any requested field';
      if (missingKeys.length) failureDetails += '\n未保存 / Not saved: ' + missingKeys.join(', ');
      if (msgEl) msgEl.innerHTML = '<span style="color:var(--negative)">' + _SV.err + ' 保存失败 / Save failed：' + esc(failureDetails).replace(/\n/g, '<br>') + '</span>';
    }

    if (savedKeys.length > 0) {
      refreshEnvConfig();
      refreshEmbInfo();
    }
  } catch (e) {
    if (msgEl) msgEl.innerHTML = '<span style="color:var(--negative)">' + _SV.err + ' 请求失败 / Request failed：' + esc(e.message) + '</span>';
  }
}

function safeNumber(value, fallback, minValue, maxValue) {
  var numeric = Number(value);
  if (!Number.isFinite(numeric)) numeric = Number(fallback);
  if (Number.isFinite(minValue)) numeric = Math.max(minValue, numeric);
  if (Number.isFinite(maxValue)) numeric = Math.min(maxValue, numeric);
  return numeric;
}

async function saveCompressKey() {
  var key = (document.getElementById('cfg-dehy-key').value || '').trim();
  if (!key) { var m = document.getElementById('dehy-key-msg'); if (m) m.textContent = '请输入 Key'; return; }
  var updates = { 'OMBRE_COMPRESS_API_KEY': key };
  document.getElementById('cfg-dehy-key').value = '';
  await _saveEnvKeys(updates, 'dehy-key-msg');
}

async function saveEmbedKey() {
  var key = (document.getElementById('cfg-emb-api-key').value || '').trim();
  var base = (document.getElementById('cfg-emb-base-url').value || '').trim();
  var model = (document.getElementById('cfg-emb-model').value || '').trim();
  var format = (document.getElementById('cfg-emb-format') || {value:'openai_compat'}).value || 'openai_compat';
  if (!key && !base && !model) { var m = document.getElementById('emb-key-msg'); if (m) m.textContent = '请先选择或填写向量服务配置'; return; }
  // Provider identity is one tuple. Saving only key/base or only model/format
  // publishes a mixed runtime immediately and can send a local model ID to a
  // cloud endpoint (or the reverse), so submit all non-secret fields at once.
  var updates = {
    'OMBRE_EMBED_BASE_URL': base,
    'OMBRE_EMBED_MODEL': model,
    'OMBRE_EMBED_FORMAT': format
  };
  if (key) { updates['OMBRE_EMBED_API_KEY'] = key; document.getElementById('cfg-emb-api-key').value = ''; }
  await _saveEnvKeys(updates, 'emb-key-msg');
}

async function saveConfig(persist) {
  var dehyTemperatureRaw = document.getElementById('cfg-dehy-temp').value.trim();
  var mergeThresholdRaw = document.getElementById('cfg-merge').value.trim();
  var dehyTemperature = dehyTemperatureRaw === '' ? NaN : Number(dehyTemperatureRaw);
  var mergeThreshold = mergeThresholdRaw === '' ? NaN : Number(mergeThresholdRaw);
  var body = {
    dehydration: {
      model: document.getElementById('cfg-dehy-model').value,
      base_url: document.getElementById('cfg-dehy-url').value,
      max_tokens: parseInt(document.getElementById('cfg-dehy-maxtokens').value) || 1024,
      temperature: Number.isFinite(dehyTemperature) ? dehyTemperature : 0.1,
      api_format: (document.getElementById('cfg-dehy-format') || {value:'openai_compat'}).value || 'openai_compat',
    },
    embedding: {
      enabled: document.getElementById('cfg-emb-enabled').value === 'true',
      model: document.getElementById('cfg-emb-model').value,
      base_url: document.getElementById('cfg-emb-base-url').value,
      backend: document.getElementById('cfg-emb-backend').value,
      api_format: (document.getElementById('cfg-emb-format') || {value:'openai_compat'}).value || 'openai_compat',
    },
    merge_threshold: Number.isFinite(mergeThreshold) ? mergeThreshold : 75,
    surfacing: {
      breath_max_results: parseInt(document.getElementById('cfg-sf-breath-results').value) || 20,
      breath_max_tokens: parseInt(document.getElementById('cfg-sf-breath-tokens').value) || 10000,
      feel_max_tokens: parseInt(document.getElementById('cfg-sf-feel-tokens').value) || 6000,
    },
    persist: persist,
  };
  var status = document.getElementById('config-status');
  try {
    var res = await authFetch('/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!res) return;
    var result = await res.json();
    if (result.ok) {
      status.innerHTML = '<span style="color:var(--positive)">' + _SV.ok + ' 已更新: ' + esc((result.updated || []).join(', ')) + '</span>';
      loadConfig();
    } else {
      status.innerHTML = '<span style="color:var(--negative)">' + _SV.err + ' ' + esc(result.error || '未知错误') + '</span>';
    }
  } catch (e) {
    status.innerHTML = '<span style="color:var(--negative)">' + _SV.err + ' 请求失败: ' + esc(e.message) + '</span>';
  }
}

checkAuth().then(authed => { if (authed) return beginAuthenticatedDashboardSession(); });

// ====== iter 1.7: version badge, plan kanban, about page ======
var _obLocalVersion = null;

async function loadVersionBadge() {
  try {
    const r = await fetch(BASE + '/api/version');
    const d = await r.json();
    _obLocalVersion = d.version || null;
    const el = document.getElementById('version-badge');
    if (el && d.version) el.textContent = 'v' + d.version;
    document.title = 'Ombre Brain · v' + (d.version || '');
    // 同步填入版本面板
    const vl = document.getElementById('ver-local-disp');
    if (vl && d.version) vl.textContent = 'v' + d.version;
  } catch(_) {}
}
loadVersionBadge();

// ====== ⓪ 版本 & 更新 ======
(function() {
  var _deployInfo = null;

  function semverGt(a, b) {
    var pa = String(a).replace(/^v/, '').split('.').map(Number);
    var pb = String(b).replace(/^v/, '').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return true;
      if (na < nb) return false;
    }
    return false;
  }

  async function loadDeployInfo() {
    if (_deployInfo) return _deployInfo;
    try {
      const r = await authFetch('/api/update-info');
      _deployInfo = r ? await r.json() : {};
    } catch(_) { _deployInfo = {}; }
    return _deployInfo;
  }

  async function showUpdatePanel(gh, latestTag) {
    var panel = document.getElementById('ver-update-panel');
    if (!panel) return;

    var remDisp = document.getElementById('ver-remote-disp');
    if (remDisp) remDisp.textContent = 'v' + latestTag;

    var remDate = document.getElementById('ver-remote-date');
    if (remDate && gh.published_at) remDate.textContent = gh.published_at.slice(0, 10) + ' 发布';

    var notesBox = document.getElementById('ver-notes-box');
    if (notesBox) {
      var body = gh.body ? gh.body.slice(0, 700) : '（作者尚未发布正式 Release 说明，可前往 GitHub 查看提交记录）';
      if (gh.body && gh.body.length > 700) body += '\n…（完整说明见 GitHub Release）';
      notesBox.textContent = body;
    }

    var info = await loadDeployInfo();
    var deployEl = document.getElementById('ver-deploy-info');
    if (deployEl) {
      deployEl.textContent = [
        '当前版本  : v' + (info.version || _obLocalVersion || '?'),
        '部署方式  : ' + (info.is_docker ? 'Docker 容器' : '裸机 / git'),
        '服务端口  : ' + (info.port || location.port || '8000'),
        '数据目录  : ' + (info.data_dir_configured ? '已配置' : '未配置'),
        '访问地址  : ' + location.origin,
      ].join('\n');
    }

    var cmdEl = document.getElementById('ver-cmd-box');
    if (cmdEl) {
      if (info.is_docker) {
        var cname = info.container_name || 'ombre-brain';
        cmdEl.textContent = 'docker pull thomas1997/ombre-brain:latest\ndocker restart ' + cname;
      } else {
        cmdEl.textContent = 'cd /path/to/ombre-brain\ngit pull origin main\n# 然后重启服务（systemctl / pm2 / screen 等）';
      }
    }

    renderPersistNote(info);
    panel.style.display = '';
  }

  // 按 /api/update-info 的持久性字段如实提示热更新会不会扛过容器重建（用户反馈 #1）。
  function renderPersistNote(info) {
    var el = document.getElementById('ver-persist-note');
    if (!el) return;
    // 裸机天然持久，无需打扰；只有 Docker 的源码层可能是易失的，需要提示。
    if (!info || info.hot_update_persistent === undefined || !info.is_docker) {
      el.style.display = 'none';
      return;
    }
    var note = info.hot_update_note || '';
    if (info.hot_update_persistent) {
      el.style.background = 'rgba(46,160,67,0.12)';
      el.style.border = '1px solid rgba(46,160,67,0.35)';
      el.style.color = 'var(--positive, #2ea043)';
      el.textContent = '✓ 热更新可持久：' + note;
    } else {
      el.style.background = 'rgba(210,153,34,0.14)';
      el.style.border = '1px solid rgba(210,153,34,0.45)';
      el.style.color = 'var(--warning, #d29922)';
      el.textContent = '⚠️ 热更新不持久：' + note;
    }
    el.style.display = '';
  }

  window.doHotUpdate = async function() {
    var btn = document.getElementById('btn-hot-update');
    var logWrap = document.getElementById('ver-update-log');
    var logBox  = document.getElementById('ver-log-box');
    var doneEl  = document.getElementById('ver-update-done');

    // v2.3.9 起：服务端热更新后会「自我重启」(os.execv 原地替换进程)。
    var _confirmMsg = '确认开始热更新？\n\n请确保已导出记忆备份，更新期间服务会自动重启（约 10-30 秒）后自行恢复。';
    if (!confirm(_confirmMsg)) return;

    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i> 更新中…'; lucide.createIcons(); }
    if (logWrap) logWrap.style.display = '';
    if (logBox)  logBox.textContent = '';
    if (doneEl)  doneEl.style.display = 'none';

    var log = function(line) { if (logBox) logBox.textContent += line + '\n'; };

    try {
      // 热更新不是可重试写操作，不能走会对瞬时 502/503/504 自动重试的
      // authFetch；否则代理丢失首个响应时可能重复发起更新任务。
      var r = await fetch(BASE + '/api/do-update', {
        method: 'POST', credentials: 'include'
      });
      if (r.status === 401) {
        checkAuth();
        log('登录状态已失效，请重新登录后重试。');
        return;
      }
      if (!r.ok) {
        var failure = {};
        try { failure = await readJsonSafe(r); } catch (parseError) {
          failure = {error: parseError.message};
        }
        log('请求失败（HTTP ' + r.status + '）：' + (failure.error || '未知错误'));
        if (r.status === 403 && failure.error === 'Cross-origin request rejected') {
          log('这不是 CORS 缺失。请让 nginx 保留公网 Host/HTTPS 转发头，并把最后一跳代理 CIDR 加入 OMBRE_TRUSTED_PROXY_CIDRS。');
        }
        return;
      }

      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var restarting = false;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        var text = decoder.decode(chunk.value);
        // SSE lines: "data: ...\n\n"
        text.split('\n').forEach(function(line) {
          if (!line.startsWith('data:')) return;
          var msg = line.slice(5).trim();
          if (!msg) return;
          if (msg === 'RESTART') {
            restarting = true;
            log('服务重启中，请稍候…');
          } else if (msg.startsWith('ERROR:')) {
            log('❌ ' + msg.slice(6));
          } else {
            log(msg);
          }
        });
        if (restarting) break;
      }

      if (restarting) {
        // 轮询 /api/version 直到服务恢复
        var newVer = null;
        for (var i = 0; i < 30; i++) {
          await new Promise(function(res) { setTimeout(res, 2000); });
          try {
            var vr = await fetch(BASE + '/api/version');
            if (vr.ok) { var vd = await vr.json(); newVer = vd.version; break; }
          } catch(_) {}
          log('等待服务恢复…');
        }
        if (newVer) {
          log('服务已恢复，新版本：v' + newVer);
          if (doneEl) doneEl.style.display = '';
          setTimeout(function() { location.reload(); }, 2500);
        } else {
          log('服务未在预期时间内恢复，请手动刷新页面。');
        }
      }
    } catch(e) {
      log('连接中断：' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="zap"></i> 立即热更新'; lucide.createIcons(); }
    }
  };

  window.checkGitHubVersion = async function() {
    var btnCheck  = document.getElementById('btn-check-ver');
    var checking  = document.getElementById('ver-checking');
    var badgeOk   = document.getElementById('ver-badge-ok');
    var badgeNew  = document.getElementById('ver-badge-new');
    var errEl     = document.getElementById('ver-error');
    var panel     = document.getElementById('ver-update-panel');

    [badgeOk, badgeNew, errEl, panel].forEach(function(e) { if (e) e.style.display = 'none'; });
    if (btnCheck) btnCheck.disabled = true;
    if (checking) checking.style.display = '';

    try {
      if (!_obLocalVersion) {
        const rv = await fetch(BASE + '/api/version');
        const dv = await rv.json();
        _obLocalVersion = dv.version || '0.0.0';
        const vl = document.getElementById('ver-local-disp');
        if (vl) vl.textContent = 'v' + _obLocalVersion;
      }

      // Dashboard never contacts third parties.  The server fetches and
      // bounds the fixed official repository, then returns a same-origin,
      // authenticated presentation summary.
      const releaseResponse = await authFetch('/api/latest-release');
      if (!releaseResponse) throw new Error('无法获取官方 Release 信息');
      const releaseEnvelope = await releaseResponse.json();
      if (!releaseResponse.ok || !releaseEnvelope.ok || !releaseEnvelope.data) {
        throw new Error(releaseEnvelope.message || '暂时无法获取官方 Release 信息');
      }
      var ghRelease = releaseEnvelope.data;
      const latestTag = ghRelease.tag_name || '';
      if (!latestTag) throw new Error('官方 Release 信息不完整');

      if (checking) checking.style.display = 'none';
      if (btnCheck) btnCheck.disabled = false;

      if (semverGt(latestTag, _obLocalVersion)) {
        if (badgeNew) badgeNew.style.display = '';
        await showUpdatePanel(ghRelease, latestTag);
      } else {
        if (badgeOk) badgeOk.style.display = '';
      }
    } catch (e) {
      if (checking) checking.style.display = 'none';
      if (btnCheck) btnCheck.disabled = false;
      if (errEl) { errEl.textContent = '检查失败：' + e.message; errEl.style.display = ''; }
    }
  };
})();

function _planCard(p) {
  var name = esc(p.name || (p.content || '').slice(0, 40) || p.id);
  var content = esc((p.content || '').slice(0, 240));
  var created = formatTimeAgo(p.created_at);
  // iter 1.8: 承诺重量条（0–1.0，不计分，仅为 active 列排序与展示）
  // iter 1.9 A2: 附上中文档位语义错（轻/中/重/必须）
  var weight = (typeof p.weight === 'number') ? p.weight : null;
  var weightHtml = (weight != null && p.status === 'active') ?
    ('<div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-dim);">' +
     '<span>重量</span>' +
     '<span style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden;"><span style="display:block;width:' + Math.round(weight*100) + '%;height:100%;background:linear-gradient(90deg,var(--accent),#d97a55);"></span></span>' +
     '<span>' + (weight*100).toFixed(0) + '% · ' + weightAnchorLabel(weight) + '</span>' +
    '</div>') : '';
  var historyHtml = '';
  if (p.change_log && p.change_log.length) {
    historyHtml = '<details style="margin-top:6px;font-size:11px;color:var(--text-dim);"><summary style="cursor:pointer;">变更历史 (' + p.change_log.length + ')</summary><ul style="margin:6px 0 0 18px;line-height:1.7;">' +
      p.change_log.map(function(h) {
        var t = (h.ts || '').replace('T',' ');
        if (h.action === 'status') return '<li>' + esc(t) + ' · status: ' + esc(h.from || '?') + ' → <b>' + esc(h.to || '?') + '</b></li>';
        if (h.action === 'edit') return '<li>' + esc(t) + ' · 内容编辑</li>';
        if (h.action === 'created') return '<li>' + esc(t) + ' · 创建（status=' + esc(h.to || 'active') + '）</li>';
        return '<li>' + esc(t) + ' · ' + esc(h.action) + '</li>';
      }).join('') + '</ul></details>';
  }
  // Action buttons depend on current status
  var actions = '';
  if (p.status === 'active') {
    actions = '<button class="icon-btn" data-plan-id="' + escAttr(p.id) + '" title="标为完成" data-ob-click="planAction%28this.dataset.planId%2C%5C%27resolve%5C%27%29"><i data-lucide="check-square"></i> 完成</button>' +
              ' <button class="icon-btn" data-plan-id="' + escAttr(p.id) + '" title="放弃" data-ob-click="planAction%28this.dataset.planId%2C%5C%27abandon%5C%27%29"><i data-lucide="x-square"></i> 放弃</button>';
  } else {
    actions = '<button class="icon-btn" data-plan-id="' + escAttr(p.id) + '" title="重新激活" data-ob-click="planAction%28this.dataset.planId%2C%5C%27reopen%5C%27%29"><i data-lucide="rotate-ccw"></i> 重新激活</button>';
  }
  actions += ' <button class="icon-btn" data-plan-id="' + escAttr(p.id) + '" title="编辑内容" data-ob-click="planEdit%28this.dataset.planId%29"><i data-lucide="pencil"></i> 编辑</button>';
  return '<div class="plan-card" data-id="' + escAttr(p.id) + '" style="border:1px solid var(--border);border-radius:4px;padding:14px 16px;background:var(--surface-solid);">' +
    '<div style="display:flex;align-items:flex-start;gap:10px;">' +
      '<div style="flex:1;">' +
        '<div style="font-weight:500;color:var(--text);margin-bottom:4px;">' + name + '</div>' +
        '<div style="font-size:13px;color:var(--text-dim);line-height:1.7;white-space:pre-wrap;">' + content + '</div>' +
        weightHtml +
        '<div style="font-size:11px;color:var(--text-light);margin-top:6px;">创建于 ' + esc(created) + ' · id <code>' + esc(p.id) + '</code></div>' +
        historyHtml +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">' + actions + '</div>' +
    '</div>' +
  '</div>';
}

async function loadPlans() {
  const board = document.getElementById('plan-board');
  const stats = document.getElementById('plan-stats');
  board.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px 0;font-size:13px;">加载中… / Loading…</div>';
  try {
    const resp = await authFetch('/api/plans');
    if (!resp) return;
    const d = await resp.json();
    if (d.error) { board.innerHTML = '<div style="color:var(--negative)">' + esc(d.error) + '</div>'; return; }
    stats.textContent = '共 ' + (d.total || 0) + ' 条 · 进行中 ' + d.active.length + ' / 已完成 ' + d.resolved.length + ' / 已放弃 ' + d.abandoned.length;
    // iter 1.8: active 列按 weight desc 排序（同重量保持后端顺序，即最近更新在前）
    var activeSorted = (d.active || []).slice().sort(function(a, b) {
      var wa = (typeof a.weight === 'number') ? a.weight : -1;
      var wb = (typeof b.weight === 'number') ? b.weight : -1;
      return wb - wa;
    });
    function section(title, items, accent) {
      if (!items.length) return '';
      return '<div><h4 style="margin:0 0 8px;color:' + accent + ';font-family:\'Cormorant Garamond\',serif;font-size:16px;font-weight:500;">' + title + ' <span style="font-size:11px;color:var(--text-light);">(' + items.length + ')</span></h4>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' + items.map(_planCard).join('') + '</div></div>';
    }
    board.innerHTML =
      section('进行中 / Active', activeSorted, 'var(--accent)') +
      section('已完成 / Resolved', d.resolved, 'var(--positive)') +
      section('已放弃 / Abandoned', d.abandoned, 'var(--text-light)');
    if (window.lucide) lucide.createIcons();
  } catch(e) {
    board.innerHTML = '<div style="color:var(--negative)">加载失败: ' + esc(e.message) + '</div>';
  }
}

async function planAction(id, action) {
  if (action === 'abandon' && !confirm('确认放弃这个计划？仍然会保留在记录里。 / Abandon this plan? It stays in the record.')) return;
  try {
    const resp = await authFetch('/api/plans/' + encodeURIComponent(id) + '/action', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: action}),
    });
    if (!resp) return;
    const d = await resp.json();
    if (d.error) { alert(d.error); return; }
    loadPlans();
  } catch(e) { alert('操作失败: ' + e.message); }
}

async function planEdit(id) {
  const planNode = Array.from(document.querySelectorAll('.plan-card'))
    .find(function(el) { return el.dataset.id === id; });
  const card = planNode ? planNode.querySelector('div[style*="white-space:pre-wrap"]') : null;
  const cur = card ? card.textContent : '';
  const next = prompt('编辑计划内容：', cur);
  if (next === null || next.trim() === '' || next === cur) return;
  try {
    const resp = await authFetch('/api/plans/' + encodeURIComponent(id) + '/action', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'edit', content: next}),
    });
    if (!resp) return;
    const d = await resp.json();
    if (d.error) { alert(d.error); return; }
    loadPlans();
  } catch(e) { alert('编辑失败: ' + e.message); }
}

async function loadAbout() {
  const el = document.getElementById('about-content');
  el.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px 0;font-size:13px;">加载中… / Loading…</div>';
  try {
    const r = await fetch(BASE + '/api/author');
    const d = await r.json();
    // 复古掌机外壳里的「一封信」：米色注塑卡 + 像素标题 + 暖色衬线正文，与全局设计语言对齐
    var html = '<div style="background:var(--surface);border-radius:var(--shell-radius);padding:34px 36px 30px;' +
      'box-shadow:8px 8px 22px var(--shadow-dark-subtle), -7px -7px 16px var(--shadow-light), inset 0 1px 0 rgba(255,255,255,0.55);">';
    html += '<div style="font-family:\'VT323\',monospace;font-size:46px;line-height:1;color:var(--accent);text-shadow:0 0 14px var(--accent-glow);letter-spacing:1px;">' + esc(d.title || '') + '</div>';
    html += '<div style="font-family:\'Share Tech Mono\',monospace;font-size:11px;letter-spacing:2px;color:var(--text-light);text-transform:uppercase;margin-top:6px;">AUTHOR · 一些</div>';
    html += '<div style="height:1px;background:var(--border);margin:18px 0 24px;"></div>';
    (d.sections || []).forEach(function(s) {
      html += '<h3 style="font-family:\'Share Tech Mono\',monospace;font-size:14px;color:var(--accent);margin:22px 0 10px;font-weight:400;letter-spacing:1px;text-transform:uppercase;">' + esc(s.heading) + '</h3>';
      html += '<div style="white-space:pre-wrap;color:var(--text);line-height:2.0;font-family:\'Noto Serif SC\',Georgia,serif;">' + esc(s.body) + '</div>';
    });
    if (d.signature) html += '<div style="margin-top:30px;text-align:right;color:var(--text-dim);font-family:\'Share Tech Mono\',monospace;font-size:14px;letter-spacing:1px;">' + esc(d.signature) + '</div>';
    var _divider = '<div style="height:1px;background:var(--border);margin:26px 0;"></div>';
    (d.contributors || []).forEach(function(c) {
      html += _divider;
      if (c.body) html += '<div style="white-space:pre-wrap;color:var(--text);line-height:2.0;font-family:\'Noto Serif SC\',Georgia,serif;text-align:center;">' + esc(c.body) + '</div>';
      if (c.signature) html += '<div style="margin-top:10px;text-align:right;color:var(--text-dim);font-family:\'Share Tech Mono\',monospace;font-size:14px;letter-spacing:1px;">' + esc(c.signature) + '</div>';
    });
    if (d.support) {
      html += _divider;
      html += '<div style="white-space:pre-wrap;color:var(--text);line-height:2.0;font-family:\'Noto Serif SC\',Georgia,serif;text-align:center;">' + esc(d.support) + '</div>';
    }
    if (d.ifdian) {
      html += '<div style="margin-top:24px;padding:22px;background:var(--surface-solid);border-radius:14px;text-align:center;' +
        'box-shadow:inset 3px 3px 8px var(--shadow-dark-subtle), inset -3px -3px 6px var(--shadow-light);">' +
        '<a href="' + escAttr(d.ifdian) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;color:#fffdf5;text-decoration:none;font-size:14px;padding:11px 26px;border-radius:13px;' +
        'background:linear-gradient(150deg, var(--accent-light), var(--accent));text-shadow:0 1px 1px rgba(120,90,20,0.35);' +
        'box-shadow:5px 5px 13px var(--shadow-dark), -4px -4px 10px var(--shadow-light), inset 0 1px 0 rgba(255,255,255,0.35);">' +
        _SV.coffee + ' 在爱发电支持我们 / Support on Afdian</a></div>';
    }
    html += '</div>';
    el.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  } catch(e) {
    el.innerHTML = '<div style="color:var(--negative)">加载失败: ' + esc(e.message) + '</div>';
  }
}

// Re-render Lucide icons whenever DOM is ready (covers static markup)
window.addEventListener('DOMContentLoaded', function() {
  if (window.lucide) lucide.createIcons();
  updateChick(0);              // 小黄鸡蛋初始（loadBuckets 后会按真实总数更新）
  startPlaceholderRotation();  // 搜索框随机 placeholder
});

// 更新/换机后发现一条记忆都没有 → 顶部红色横幅，引导从 GitHub 恢复。
// 只在确实零记忆且已配置 GitHub 时出现；导入按钮平时仍在设置里随时可用。
async function checkEmptyMemoryBanner() {
  try {
    var sr = await authFetch('/api/status');
    if (!sr) return;
    var s = await sr.json();
    var b = s.buckets || {};
    var live = (b.permanent || 0) + (b.dynamic || 0);
    if (live > 0) { var ex = document.getElementById('empty-mem-banner'); if (ex) ex.remove(); return; }
    // 是否配置了 GitHub（有才提恢复）
    var ghOk = false;
    try { var gr = await authFetch('/api/github/status'); if (gr) { var gd = await gr.json(); ghOk = !!(gd && (gd.configured || gd.token_set)); } } catch (e) {}
    if (document.getElementById('empty-mem-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'empty-mem-banner';
    bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#b85c3c;color:#fff;padding:10px 16px;font-size:13px;line-height:1.6;display:flex;align-items:center;gap:12px;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    bar.innerHTML = '<b>⚠️ 检测到当前没有任何记忆</b>'
      + (ghOk
          ? '<span>可从 GitHub 备份恢复（会写入本地，导入前自动备份）。</span><button style="background:#fff;color:#b85c3c;border:none;border-radius:4px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;" data-ob-click="runGithubImport%28%29">从 GitHub 恢复记忆</button>'
          : '<span>若你在 GitHub 备份过记忆，去「GitHub 同步」填好配置后即可一键恢复。</span>')
      + '<button style="margin-left:auto;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;" data-ob-click="this.parentNode.remove%28%29">忽略</button>';
    document.body.insertBefore(bar, document.body.firstChild);
  } catch (e) { /* ignore */ }
}
window.addEventListener('load', function() {
  if (window.lucide) lucide.createIcons();
  // iter 1.7 §D: auto-render any dynamically-inserted [data-lucide] icons
  // 性能保护：debounce 50ms，避免在大量 innerHTML 时疯狂触发
  if (window.MutationObserver && window.lucide) {
    var rafToken = null;
    var obs = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes && muts[i].addedNodes.length) {
          if (rafToken) clearTimeout(rafToken);
          rafToken = setTimeout(function() {
            // createIcons replaces <i> with <svg>. Disconnect while it mutates
            // the DOM so the observer cannot recursively feed itself forever.
            obs.disconnect();
            try { lucide.createIcons(); }
            finally {
              obs.observe(document.body, {childList: true, subtree: true});
              rafToken = null;
            }
          }, 50);
          break;
        }
      }
    });
    obs.observe(document.body, {childList: true, subtree: true});
  }
});

// --- Import functions ---
const uploadZone = document.getElementById('import-upload-zone');
const fileInput = document.getElementById('import-file-input');
let pendingImportFile = null;

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.style.borderColor = 'var(--accent)'; });
uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = 'var(--border)'; });
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.style.borderColor = 'var(--border)';
  if (e.dataTransfer.files.length) runImportPreflight(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) runImportPreflight(fileInput.files[0]); });

function renderImportPreflight(data) {
  const panel = document.getElementById('import-preflight-panel');
  const fileEl = document.getElementById('import-preflight-file');
  const summary = document.getElementById('import-preflight-summary');
  const warn = document.getElementById('import-preflight-warnings');
  const preview = document.getElementById('import-preflight-preview');
  const btn = document.getElementById('import-start-confirm-btn');
  if (!panel || !summary || !btn) return;
  panel.style.display = '';
  if (fileEl) fileEl.textContent = data.filename || (pendingImportFile ? pendingImportFile.name : '');
  if (!data.ok) {
    summary.style.color = 'var(--negative)';
    summary.textContent = '预检失败：' + (data.error || '无法识别文件');
    btn.disabled = true;
    if (warn) warn.style.display = 'none';
    if (preview) preview.style.display = 'none';
    return;
  }
  summary.style.color = data.can_start ? 'var(--text-dim)' : 'var(--warning)';
  summary.innerHTML =
    '格式：<b>' + esc(data.detected_format || 'unknown') + '</b>'
    + ' · 轮次：<b>' + (data.turns_count || 0) + '</b>'
    + ' · 分块：<b>' + (data.chunks_count || 0) + '</b>'
    + ' · 预计 API 调用：<b>' + (data.estimated_api_calls || 0) + '</b>'
    + ' · 大小：<b>' + Math.round((data.size_bytes || 0) / 1024) + ' KB</b>'
    + (data.requires_llm !== false && !data.llm_ready ? '<br><span style="color:var(--negative)">压缩/打标 LLM 未就绪，暂不能导入。</span>' : '')
    + (data.import_running ? '<br><span style="color:var(--negative)">已有导入任务运行中，请完成后再开始。</span>' : '');
  const warnings = data.warnings || [];
  if (warn) {
    warn.style.display = warnings.length ? '' : 'none';
    warn.innerHTML = warnings.map(function(w) { return '⚠ ' + esc(w); }).join('<br>');
  }
  if (preview) {
    preview.style.display = data.first_chunk_preview ? '' : 'none';
    preview.textContent = data.first_chunk_preview || '';
  }
  btn.disabled = !data.can_start;
}

async function runImportPreflight(file) {
  pendingImportFile = file;
  const panel = document.getElementById('import-preflight-panel');
  const summary = document.getElementById('import-preflight-summary');
  const btn = document.getElementById('import-start-confirm-btn');
  if (panel) panel.style.display = '';
  if (summary) { summary.style.color = 'var(--text-dim)'; summary.textContent = '预检中… / Pre-checking…'; }
  if (btn) btn.disabled = true;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(BASE + '/api/import/preflight', { method: 'POST', body: fd });
    const data = await res.json();
    renderImportPreflight(data);
  } catch (e) {
    renderImportPreflight({ ok: false, error: e.message || String(e), filename: file.name });
  }
}

function clearImportPreflight() {
  pendingImportFile = null;
  if (fileInput) fileInput.value = '';
  const panel = document.getElementById('import-preflight-panel');
  if (panel) panel.style.display = 'none';
}

async function confirmStartImport() {
  if (!pendingImportFile) return;
  const file = pendingImportFile;
  pendingImportFile = null;
  const btn = document.getElementById('import-start-confirm-btn');
  if (btn) btn.disabled = true;
  await startImport(file);
}

async function startImport(file) {
  const preserveRaw = document.getElementById('import-preserve-raw').checked;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(BASE + '/api/import/upload?preserve_raw=' + (preserveRaw ? '1' : '0'), { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { alert('导入失败: ' + data.error); return; }
    clearImportPreflight();
    document.getElementById('import-progress').style.display = '';
    document.getElementById('import-pause-btn').style.display = '';
    pollImportStatus();
  } catch (e) { alert('上传失败: ' + e.message); }
}

let importPollTimer;
async function pollImportStatus() {
  clearInterval(importPollTimer);
  try {
    const res = await fetch(BASE + '/api/import/status');
    const s = await res.json().catch(() => null);
    if (!s) { alert('导入状态读取失败（服务器响应非 JSON）/ Failed to read import status (server response was not JSON)'); return; }
    updateImportUI(s);
    if (s.status === 'running') {
      importPollTimer = setInterval(async () => {
        try {
          const r2 = await fetch(BASE + '/api/import/status');
          const s2 = await r2.json().catch(() => null);
          if (s2) updateImportUI(s2);
        } catch(e) {}
      }, 2000);
    }
  } catch(e) { alert('导入状态加载失败: ' + (e.message || e)); }
}

function updateImportUI(s) {
  const prog = document.getElementById('import-progress');
  if (s.status === 'idle') { prog.style.display = 'none'; return; }
  prog.style.display = '';
  const pct = s.total_chunks ? Math.round(s.processed / s.total_chunks * 100) : 0;
  document.getElementById('import-progress-bar').style.width = pct + '%';
  document.getElementById('import-progress-text').textContent = s.processed + '/' + s.total_chunks;
  document.getElementById('import-api-calls').textContent = s.api_calls;
  document.getElementById('import-created').textContent = s.memories_created;
  document.getElementById('import-skipped').textContent = s.memories_skipped || 0;
  document.getElementById('import-raw').textContent = s.memories_raw;
  const statusMap = { running: _SV.clock+' 导入中…', paused: _SV.pause+' 已暂停', completed: _SV.ok+' 完成', partial: _SV.warn+' 部分完成', error: _SV.err+' 出错' };
  document.getElementById('import-status-text').innerHTML = statusMap[s.status] || esc(s.status);
  document.getElementById('import-pause-btn').style.display = s.status === 'running' ? '' : 'none';
  if (s.status !== 'running') clearInterval(importPollTimer);
  if (s.status === 'completed' || s.status === 'partial') {
    loadImportResults();
    loadBuckets();
  }
  const errDiv = document.getElementById('import-errors');
  const errList = document.getElementById('import-error-list');
  const diagnostics = Array.isArray(s.diagnostics) ? s.diagnostics : [];
  if (diagnostics.length) {
    errDiv.style.display = '';
    errList.innerHTML = diagnostics.map(function(item) {
      const solution = item.solution
        ? '<div style="margin-top:6px;color:var(--text-dim);"><b style="color:var(--text);">解决方案：</b>' + esc(item.solution) + '</div>'
        : '<div style="margin-top:6px;color:var(--text-dim);">暂未匹配到通用解决方案，请复制下方具体报错进行排查。</div>';
      return '<div style="padding:10px 11px;background:var(--surface-solid);border-radius:8px;box-shadow:inset 2px 2px 5px var(--shadow-dark-subtle),inset -2px -2px 4px var(--shadow-light);">'
        + '<div style="font-weight:700;color:var(--negative);">' + esc(item.title || '导入处理出错') + '</div>'
        + '<code style="display:block;margin-top:6px;white-space:pre-wrap;word-break:break-word;color:var(--negative);font-family:\'Share Tech Mono\',\'SF Mono\',Consolas,monospace;">' + esc(item.error || '') + '</code>'
        + solution + '</div>';
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } else { errDiv.style.display = 'none'; }
}

async function pauseImport() {
  try { await fetch(BASE + '/api/import/pause', { method: 'POST' }); } catch(e) { alert('暂停失败: ' + (e.message || e)); }
}

let importResultsLoadGeneration = 0;
let importResultsNextOffset = 0;
const IMPORT_RESULTS_PAGE_SIZE = 50;

function updateImportResultsMoreButton(hasMore) {
  const button = document.getElementById('import-results-more');
  if (button) button.style.display = hasMore ? 'block' : 'none';
}

async function loadMoreImportResults() {
  if (importResultsNextOffset === null) return true;
  return loadImportResults({append:true, preserveScroll:true});
}

async function loadImportResults(options) {
  const container = document.getElementById('import-results-list');
  if (!container) return false;
  const opts = options && typeof options === 'object' ? options : {};
  const append = opts.append === true;
  const offset = append ? importResultsNextOffset : 0;
  if (append && offset === null) return true;
  const generation = ++importResultsLoadGeneration;
  const preserveScroll = opts.preserveScroll === true;
  const requestedScrollTop = Number(opts.scrollTop);
  const previousScrollTop = preserveScroll
    ? (Number.isFinite(requestedScrollTop) ? Math.max(0, requestedScrollTop) : container.scrollTop)
    : 0;
  container.setAttribute('aria-busy', 'true');
  if (!append && !preserveScroll) container.innerHTML = '<div class="loading">加载中… / Loading…</div>';
  try {
    const query = '?limit=' + IMPORT_RESULTS_PAGE_SIZE + '&offset=' + Number(offset || 0);
    const res = await fetch(BASE + '/api/import/results' + query);
    const data = await readJsonSafe(res);
    if (generation !== importResultsLoadGeneration) return false;
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.buckets)) {
      throw new Error('导入结果响应无效 / Invalid import results response');
    }

    const nextOffset = Number(data.next_offset);
    importResultsNextOffset = data.has_more && Number.isInteger(nextOffset) && nextOffset >= 0
      ? nextOffset
      : null;
    updateImportResultsMoreButton(importResultsNextOffset !== null);

    if (!data.buckets.length) {
      if (!append) container.innerHTML = '<p style="color:var(--text-dim)">暂无已导入记忆</p>';
      if (preserveScroll) container.scrollTop = previousScrollTop;
      return true;
    }

    const cards = data.buckets.map(b => `
      <div data-review-bucket-id="${escAttr(b.id)}" style="background:var(--surface);border-radius:12px;padding:14px;margin:8px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <b>${esc(b.name || b.id)} <span title="由对话导入" style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 5px;white-space:nowrap;">被导入</span></b>
          <span style="font-size:11px;color:var(--text-dim);">${esc(b.type)} | ${esc((b.domain||[]).join(','))} | imp:${Number(b.importance || 0)}</span>
        </div>
        <p style="font-size:13px;margin:6px 0;white-space:pre-wrap;">${esc(b.content)}</p>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">${esc((b.tags||[]).map(t=>'#'+t).join(' '))}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button data-bucket-id="${escAttr(b.id)}" class="icon-btn" title="编辑完整记忆 / Edit full memory" data-ob-click="openImportedBucketEditor%28this.dataset.bucketId%29"><svg class="icon" aria-hidden="true"><use href="#i-edit"></use></svg> 编辑</button>
          <button data-bucket-id="${escAttr(b.id)}" class="icon-btn" title="固定为永久记忆" data-ob-click="reviewAction%28this.dataset.bucketId%2C%27pin%27%29"><i data-lucide="pin"></i> 固定</button>
          <button data-bucket-id="${escAttr(b.id)}" class="icon-btn" title="标为重要" data-ob-click="reviewAction%28this.dataset.bucketId%2C%27important%27%29"><i data-lucide="star"></i> 重要</button>
          <button data-bucket-id="${escAttr(b.id)}" class="icon-btn" title="标为噪声并resolve" data-ob-click="reviewAction%28this.dataset.bucketId%2C%27noise%27%29"><i data-lucide="trash-2"></i> 噪声</button>
          <button data-bucket-id="${escAttr(b.id)}" class="icon-btn" title="删除到档案 / Move to archive" style="color:var(--negative);" data-ob-click="if%28confirm%28%27%E7%A1%AE%E5%AE%9A%E7%A7%BB%E5%85%A5%E5%88%A0%E9%99%A4%E6%A1%A3%E6%A1%88%EF%BC%9F%20%2F%20Move%20to%20delete%20archive%3F%27%29%29reviewAction%28this.dataset.bucketId%2C%27delete%27%29"><i data-lucide="x"></i> 删除到档案</button>
        </div>
      </div>
    `).join('');
    if (append) container.insertAdjacentHTML('beforeend', cards);
    else container.innerHTML = cards;
    if (preserveScroll) container.scrollTop = previousScrollTop;
    return true;
  } catch(e) {
    if (generation !== importResultsLoadGeneration) return false;
    if (!append) container.innerHTML = '<p style="color:var(--negative)">加载失败: ' + esc(e.message) + '</p>';
    updateImportResultsMoreButton(importResultsNextOffset !== null);
    return false;
  } finally {
    if (generation === importResultsLoadGeneration) container.removeAttribute('aria-busy');
  }
}
async function openImportedBucketEditor(bid) {
  // 导入结果只含正文预览；先进入详情，确保编辑器拿到完整 Markdown 正文。
  if (!await showDetail(bid)) return;
  const editor = document.getElementById('bucket-edit-form');
  if (!editor) return;
  editor.open = true;
  const contentInput = document.getElementById('edit-content');
  if (contentInput) contentInput.focus();
  else editor.scrollIntoView({block:'start'});
}

async function detectPatterns() {
  const container = document.getElementById('import-patterns');
  container.innerHTML = '<div class="loading">检测中…</div>';
  try {
    const res = await fetch(BASE + '/api/import/patterns');
    const data = await res.json();
    if (!data.patterns || !data.patterns.length) { container.innerHTML = '<p style="color:var(--text-dim)">未检测到高频模式</p>'; return; }
    container.innerHTML = data.patterns.map(p => `
      <div style="background:var(--surface);border-radius:12px;padding:14px;margin:8px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b>${esc(p.pattern_name)}</b>
          <span style="font-size:12px;color:var(--text-dim);">出现 ${Number(p.count || 0)} 次</span>
        </div>
        <p style="font-size:13px;margin:6px 0;">${esc(p.pattern_content)}</p>
        <div style="display:flex;gap:8px;">
          <button data-bucket-id="${escAttr((p.bucket_ids || [])[0])}" class="icon-btn" data-ob-click="reviewAction%28this.dataset.bucketId%2C%27pin%27%29"><i data-lucide="pin"></i> 固定</button>
          <button data-bucket-id="${escAttr((p.bucket_ids || [])[0])}" class="icon-btn" data-ob-click="reviewAction%28this.dataset.bucketId%2C%27important%27%29"><i data-lucide="star"></i> 重要</button>
          <button data-bucket-ids="${escAttr(JSON.stringify(p.bucket_ids || []))}" class="icon-btn" data-ob-click="batchReview%28this.dataset.bucketIds%2C%27noise%27%29"><i data-lucide="trash-2"></i> 噪声</button>
        </div>
      </div>
    `).join('');
  } catch(e) { container.innerHTML = '<p style="color:var(--negative)">检测失败: ' + esc(e.message) + '</p>'; }
}

async function reviewAction(bid, action) {
  try {
    const response = await fetch(BASE + '/api/import/review', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ decisions: [{ bucket_id: bid, action }] })
    });
    const result = await readJsonSafe(response);
    if (!response.ok || !result || result.applied !== 1 || result.errors) {
      throw new Error((result && result.error) || '审阅操作未生效');
    }
    // Remove card from UI
    const card = Array.from(document.querySelectorAll('[data-review-bucket-id]'))
      .find(function(el) { return el.dataset.reviewBucketId === bid; });
    if (card) card.style.display = 'none';
  } catch(e) { alert('操作失败: ' + (e.message || e)); }
}

async function batchReview(idsJson, action) {
  try {
    const ids = JSON.parse(idsJson);
    if (!Array.isArray(ids) || !ids.length) throw new Error('没有可审阅的记忆');
    const response = await fetch(BASE + '/api/import/review', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ decisions: ids.map(id => ({ bucket_id: id, action })) })
    });
    const result = await readJsonSafe(response);
    if (!response.ok || !result || result.applied !== ids.length || result.errors) {
      const summary = result
        ? `成功 ${Number(result.applied || 0)}，失败 ${Number(result.errors || 0)}`
        : '服务器未返回结果';
      throw new Error((result && result.error) || summary);
    }
    detectPatterns();
  } catch(e) { alert('批量操作失败: ' + (e.message || e)); }
}

// ========================================
// iter 1.6 §3 — heartbeat indicator + log viewer
// ========================================
// v3-debug-panel
let _v3DebugRecords = [];

async function loadV3Debug() {
  const list = document.getElementById('v3-debug-list');
  const meta = document.getElementById('v3-debug-meta');
  const detail = document.getElementById('v3-debug-detail');
  if (!list || !meta || !detail) return;
  list.innerHTML = '<div class="loading" style="padding:20px;">loading...</div>';
  meta.textContent = '';
  const moduleValue = (document.getElementById('v3-debug-module')?.value || '').trim();
  const operationValue = (document.getElementById('v3-debug-operation')?.value || '').trim();
  const params = new URLSearchParams({ limit: '30' });
  if (moduleValue) params.set('module', moduleValue);
  if (operationValue) params.set('operation', operationValue);
  try {
    const r = await authFetch('/api/v3/debug/decisions?' + params.toString());
    if (!r) return;
    const data = await readJsonSafe(r);
    _v3DebugRecords = data.records || [];
    meta.textContent = (_v3DebugRecords.length || 0) + ' records';
    if (!_v3DebugRecords.length) {
      list.innerHTML = '<div class="loading" style="padding:20px;">empty</div>';
      detail.innerHTML = '';
      return;
    }
    list.innerHTML = _v3DebugRecords.map(renderV3DebugDecision).join('');
    await replayV3Decision(_v3DebugRecords[0].id);
  } catch (e) {
    list.innerHTML = '<div style="color:var(--negative);font-size:12px;">' + esc(e.message) + '</div>';
  }
}

function renderV3DebugDecision(record, index) {
  const summary = record.summary || {};
  const ok = summary.consistency_ok && summary.outcome_ok;
  const allowed = summary.policy_allowed;
  const badgeColor = ok && allowed ? 'var(--positive)' : (allowed ? 'var(--warning)' : 'var(--negative)');
  const surfaces = (summary.projection_surfaces || []).join(', ') || '-';
  const recordId = escAttr(record.id || '');
  return '<button data-decision-id="' + recordId + '" ' +
    'style="text-align:left;background:var(--surface-solid);border:1px solid var(--border);border-radius:4px;padding:10px 12px;cursor:pointer;color:var(--text);" data-ob-click="replayV3Decision%28this.dataset.decisionId%29">' +
    '<div style="display:flex;align-items:center;gap:8px;font-size:12px;">' +
      '<span style="width:7px;height:7px;border-radius:50%;background:' + badgeColor + ';display:inline-block;flex-shrink:0;"></span>' +
      '<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(record.module || '-') + '.' + esc(record.operation || '-') + '</span>' +
      '<span style="margin-left:auto;color:var(--text-light);font-size:11px;">#' + (index + 1) + '</span>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-dim);margin-top:6px;word-break:break-all;">' + esc(record.command_id || '') + '</div>' +
    '<div style="font-size:11px;color:var(--text-light);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(surfaces) + '</div>' +
  '</button>';
}

async function replayV3Decision(identifier) {
  const detail = document.getElementById('v3-debug-detail');
  if (!detail) return;
  detail.innerHTML = '<div class="loading" style="padding:20px;">replay...</div>';
  try {
    const r = await authFetch('/api/v3/debug/replay/' + encodeURIComponent(identifier));
    if (!r) return;
    const data = await readJsonSafe(r);
    const replay = data.replay || {};
    const explanation = replay.explanation || {};
    const issues = replay.issues || [];
    detail.innerHTML =
      '<div style="display:grid;grid-template-columns:130px 1fr;gap:8px 12px;font-size:12px;">' +
        '<span style="color:var(--text-light);">decision</span><span style="word-break:break-all;">' + esc((data.record || {}).id || identifier) + '</span>' +
        '<span style="color:var(--text-light);">module</span><span>' + esc(explanation.module || '-') + '.' + esc(explanation.operation || '-') + '</span>' +
        '<span style="color:var(--text-light);">policy</span><span>' + String(explanation.policy_allowed) + '</span>' +
        '<span style="color:var(--text-light);">consistency</span><span>' + String(explanation.consistency_ok) + '</span>' +
        '<span style="color:var(--text-light);">replay</span><span>' + String(replay.ok) + '</span>' +
        '<span style="color:var(--text-light);">surfaces</span><span style="word-break:break-all;">' + esc((explanation.projection_surfaces || []).join(', ') || '-') + '</span>' +
      '</div>' +
      '<pre style="margin-top:14px;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:12px;white-space:pre-wrap;word-break:break-word;max-height:42vh;overflow:auto;font-size:11px;">' +
      esc(JSON.stringify({ issues: issues, explanation: explanation }, null, 2)) +
      '</pre>';
  } catch (e) {
    detail.innerHTML = '<div style="color:var(--negative);font-size:12px;">' + esc(e.message) + '</div>';
  }
}
// v3-debug-panel-end

async function pollHeartbeat() {
  const dot = document.getElementById('heartbeat-dot');
  const txt = document.getElementById('heartbeat-text');
  try {
    const r = await fetch(BASE + '/api/heartbeat');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    dot.style.background = '#3a9b5c';
    const idle = Math.floor((Date.now()/1000) - (d.last_op_ts || 0));
    var decaying = d.decay_engine === 'running';
    txt.textContent = '在线 · ' + (decaying ? '衰减运行中' : '衰减停');
    txt.title = 'uptime ' + d.uptime_s + 's · 上次活跃 ' + idle + 's 前';
    dot.classList.add('breathing');   // 在线即呼吸，衰减状态只影响文字
  } catch (e) {
    dot.style.background = '#c45a3a';
    dot.classList.remove('breathing');
    txt.textContent = '离线';
    txt.title = e.message;
  }
}

async function loadLogs() {
  const out = document.getElementById('logs-output');
  const meta = document.getElementById('logs-meta');
  out.textContent = '加载中… / Loading…';
  const level = document.getElementById('logs-level').value;
  const limit = parseInt(document.getElementById('logs-limit').value, 10) || 200;
  try {
    const r = await fetch(BASE + '/api/logs?level=' + encodeURIComponent(level) + '&limit=' + limit);
    const d = await r.json();
    if (d.error) { out.textContent = '加载失败: ' + d.error; return; }
    // API returns a logical file name only; never reconstruct or expose a
    // deployment filesystem path in the Dashboard.
    const fileName = d.log_file_name || d.log_source || '';
    meta.removeAttribute('title');
    if (!d.lines || !d.lines.length) {
      out.textContent = d.note || '(无符合条件的日志)';
      meta.textContent = fileName;
      return;
    }
    out.textContent = d.lines.join('\n');
    meta.textContent = fileName + ' · ' + d.count + ' 行';
    out.scrollTop = out.scrollHeight;
  } catch (e) { out.textContent = '加载失败: ' + e.message; }
}

// ========================================
// 统一错误体系 — /api/errors/recent + /api/errors/clear
// ========================================
function _obLevelStyle(lvl) {
  if (lvl === 'F') return { bg: 'rgba(184,92,60,0.12)', border: 'rgba(184,92,60,0.5)', label: _SV.stop+' Fatal',   color: 'var(--accent)' };
  if (lvl === 'E') return { bg: 'rgba(184,92,60,0.08)', border: 'rgba(184,92,60,0.35)', label: _SV.err+' Error',   color: 'var(--accent)' };
  if (lvl === 'W') return { bg: 'rgba(212,175,55,0.10)', border: 'rgba(212,175,55,0.40)', label: _SV.warn+' Warn',  color: '#7d6720' };
  return { bg: 'rgba(120,140,170,0.08)', border: 'rgba(120,140,170,0.30)', label: _SV.info+' Info', color: 'var(--text-dim)' };
}

async function loadOBErrors() {
  const box = document.getElementById('errors-list');
  const meta = document.getElementById('errors-meta');
  const minLvl = document.getElementById('errors-min-level').value || 'W';
  box.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px 0;font-size:12px;">加载中… / Loading…</div>';
  try {
    const r = await fetch(BASE + '/api/errors/recent?min_level=' + encodeURIComponent(minLvl) + '&limit=100');
    const d = await r.json();
    if (d.error) { box.innerHTML = '<div style="color:var(--negative);">' + esc(d.error) + '</div>'; return; }
    const items = d.errors || [];
    if (!items.length) {
      box.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px 0;font-size:12px;">暂无 ' + minLvl + ' 级以上的错误记录。</div>';
      meta.textContent = '0 条';
      return;
    }
    meta.textContent = items.length + ' 条';
    box.innerHTML = items.map(function(it, i) {
      var st = _obLevelStyle(it.level || 'W');
      var copyId = 'ob-err-copy-' + i;
      var formatted = (it.formatted || '').replace(/`/g, '\\`').replace(/\$/g, '\\$');
      return (
        '<div style="border:1px solid ' + st.border + ';background:' + st.bg + ';border-radius:3px;padding:10px 12px;">' +
        '<div style="display:flex;align-items:center;gap:10px;font-size:12px;">' +
          '<span style="color:' + st.color + ';font-weight:600;">' + st.label + '</span>' +
          '<span style="font-family:Menlo,monospace;color:var(--text);">' + esc(it.code || '?') + '</span>' +
          '<span style="color:var(--text);">' + esc(it.title || '') + '</span>' +
          '<span style="margin-left:auto;color:var(--text-dim);font-size:11px;">' + esc(it.ts || '') + '</span>' +
          '<button id="' + copyId + '" ' +
            'style="background:none;border:1px solid var(--border);color:var(--text-dim);border-radius:2px;padding:3px 10px;font-size:11px;cursor:pointer;" data-ob-action="copy-ob-error" data-error-index="' + i + '">复制</button>' +
        '</div>' +
        (it.detail ? '<div style="font-size:12px;color:var(--text-dim);margin-top:6px;line-height:1.6;">' + esc(it.detail) + '</div>' : '') +
        '<details style="margin-top:6px;"><summary style="font-size:11px;color:var(--text-dim);cursor:pointer;">展开完整报告（含建议+最近 15 条 log）</summary>' +
        '<pre style="margin:8px 0 0;background:var(--bg);padding:10px;border-radius:2px;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-all;font-family:Menlo,monospace;color:var(--text);">' + esc(it.formatted || '') + '</pre>' +
        '</details>' +
        '</div>'
      );
    }).join('');
    // 把 formatted 暂存到 window 供 copyOBError 使用
    window._obErrorFormatted = items.map(function(it) { return it.formatted || ''; });
  } catch (e) {
    box.innerHTML = '<div style="color:var(--negative);">加载失败：' + esc(e.message) + '</div>';
  }
}

function copyOBError(i) {
  var arr = window._obErrorFormatted || [];
  var text = arr[i] || '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(function() {
    var btn = document.getElementById('ob-err-copy-' + i);
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function() { btn.textContent = orig; }, 1200);
    }
  }).catch(function(e) { alert('复制失败：' + e.message); });
}

async function clearOBErrors() {
  if (!confirm('清空错误日志？此操作不影响 server.log，仅清空 errors.jsonl。 / Clear error log? This does not touch server.log, only errors.jsonl.')) return;
  try {
    var r = await fetch(BASE + '/api/errors/clear', { method: 'POST' });
    var d = await r.json();
    if (d.error) { alert('清空失败：' + d.error); return; }
    await loadOBErrors();
  } catch (e) { alert('清空失败：' + e.message); }
}

// ========================================
// iter 1.6 §2 — export zip + §4 duplicates panel
// ========================================
function downloadExport() {
  // 直接走浏览器下载
  window.location.href = BASE + '/api/export';
}

// ========================================
// MCP 配置面板
// ========================================

function _getMcpOrigin() {
  const mode = document.querySelector('input[name="mcp-mode"]:checked')?.value;
  if (mode === 'public') {
    let domain = (document.getElementById('mcp-custom-domain')?.value || '').trim();
    if (!domain) return location.origin;
    if (!/^https?:\/\//i.test(domain)) domain = 'https://' + domain;
    return domain.replace(/\/mcp\/?$/i, '').replace(/\/+$/, '');
  }
  // 本地模式：固定用 127.0.0.1 + 当前端口，保证 Claude Desktop 连本机 Docker
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  return 'http://127.0.0.1:' + port;
}

function onMcpAuthModeChange() {
  const sel = document.getElementById('cfg-mcp-auth');
  const panel = document.getElementById('mcp-token-panel');
  if (!sel || !panel) return;
  panel.style.display = (sel.value === 'token' || sel.value === 'hybrid') ? '' : 'none';
  const statusEl = document.getElementById('mcp-token-status');
  if (statusEl) {
    statusEl.textContent = window._mcpTokenConfigured
      ? ('已设置（' + (window._mcpTokenHint || '***') + '）')
      : '未设置';
  }
}

async function saveMcpAuth() {
  const msg = document.getElementById('mcp-auth-msg');
  const sel = document.getElementById('cfg-mcp-auth').value; // 'oauth' | 'hybrid' | 'token' | 'off'
  const payload = sel === 'off'
    ? { mcp_require_auth: false, persist: true }
    : { mcp_require_auth: true, mcp_auth_mode: sel, persist: true };
  try {
    const res = await authFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res) return;
    const result = await res.json();
    if (result.ok) {
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      msg.style.color = (warnings.length || result.restart_required) ? 'var(--warning)' : 'var(--positive)';
      msg.textContent = (result.message || (result.restart_required ? '已保存，需要重启服务后生效' : '已保存'))
        + (warnings.length ? '；高风险豁免：' + warnings.join('；') : '');
      setRestartRequired(!!result.restart_required, 'MCP 鉴权设置已保存');
    } else {
      msg.style.color = 'var(--negative)';
      msg.textContent = result.error || '保存失败';
    }
  } catch (e) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '请求失败: ' + e.message;
  }
}

let _mcpTokenPlaintext = '';
async function regenerateMcpToken() {
  const msg = document.getElementById('mcp-token-msg');
  msg.style.color = 'var(--text-light)';
  msg.textContent = '生成中…';
  try {
    const res = await authFetch('/api/mcp-token/regenerate', { method: 'POST' });
    if (!res) return;
    const result = await res.json();
    if (result.ok) {
      _mcpTokenPlaintext = result.token || '';
      window._mcpTokenConfigured = true;
      window._mcpTokenHint = result.token_hint || null;
      document.getElementById('mcp-token-status').textContent =
        '已设置（' + (window._mcpTokenHint || '***') + '）';
      const reveal = document.getElementById('mcp-token-reveal');
      const valueEl = document.getElementById('mcp-token-value');
      if (reveal && valueEl) {
        valueEl.textContent = _mcpTokenPlaintext;
        reveal.style.display = '';
      }
      msg.style.color = result.env_override ? 'var(--warning)' : 'var(--positive)';
      msg.textContent = result.message || '已生成';
    } else {
      msg.style.color = 'var(--negative)';
      msg.textContent = result.error || '生成失败';
    }
  } catch (e) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '请求失败: ' + e.message;
  }
}

function copyMcpToken() {
  if (!_mcpTokenPlaintext) return;
  navigator.clipboard.writeText(_mcpTokenPlaintext).then(function() {
    const msg = document.getElementById('mcp-token-msg');
    msg.style.color = 'var(--positive)';
    msg.textContent = '已复制';
  });
}

function highlightTransport(t) {
  document.querySelectorAll('#transport-btns .transport-btn').forEach(function(b) {
    var on = b.dataset.transport === t;
    b.style.background = on ? 'var(--accent)' : 'none';
    b.style.color = on ? '#fff' : 'var(--text)';
    b.style.fontWeight = on ? '600' : '400';
    b.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
  });
}

async function switchTransport(t) {
  var msg = document.getElementById('transport-msg');
  var warn;
  if (t === 'stdio') {
    warn = '⚠️ 切换到 stdio 会关闭 Web Dashboard 和所有 HTTP 服务，\n'
         + '并且你将无法再从网页切回（需在服务器改 config.yaml / 环境变量恢复）。\n\n确定继续吗？';
  } else {
    warn = '切换到 ' + t + ' 会自动重启服务（约 10-30 秒）。确定继续吗？';
  }
  if (!confirm(warn)) return;
  msg.style.color = 'var(--text-dim)';
  msg.textContent = '正在切换并重启…';
  try {
    var res = await authFetch('/api/transport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transport: t }),
    });
    if (!res) return;
    var r = await res.json();
    if (r.ok) {
      if (r.restarting === false) {
        msg.style.color = 'var(--positive)';
        msg.textContent = r.note || '传输模式未变化';
        return;
      }
      highlightTransport(t);
      if (t === 'stdio') {
        msg.style.color = 'var(--negative)';
        msg.textContent = '已切到 stdio，HTTP 服务即将关闭，本页面将失联。';
      } else {
        msg.style.color = 'var(--positive)';
        msg.textContent = '已切到 ' + t + '，服务重启中（约 10-30 秒），稍后刷新页面。';
      }
    } else {
      msg.style.color = 'var(--negative)';
      msg.textContent = r.error || '切换失败';
    }
  } catch (e) {
    // 自重启会掐断本次连接，fetch 抛错是预期的
    msg.style.color = 'var(--text-dim)';
    msg.textContent = '请求已发出，服务重启中，稍后刷新页面。';
  }
}

async function saveHostPort() {
  const msg = document.getElementById('host-port-msg');
  const raw = (document.getElementById('cfg-host-port').value || '').trim();
  const port = raw === '' ? null : parseInt(raw, 10);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    msg.style.color = 'var(--negative)'; msg.textContent = '端口需为 1-65535'; return;
  }
  try {
    const res = await authFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_port: port === null ? 18001 : port, persist: true }),
    });
    if (!res) return;
    const result = await res.json();
    if (result.ok) {
      msg.style.color = 'var(--positive)';
      msg.textContent = '已保存（按上方提示重启 / 重建生效）';
    } else {
      msg.style.color = 'var(--negative)';
      msg.textContent = result.error || '保存失败';
    }
  } catch (e) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '请求失败: ' + e.message;
  }
}

function renderMcpUrls() {
  const origin = _getMcpOrigin();
  const mainUrl = origin + '/mcp';
  document.getElementById('mcp-url-main').textContent = mainUrl;
  // 更新 JSON 预览
  const cfg = _buildClaudeDesktopConfig(mainUrl);
  document.getElementById('mcp-json-preview').textContent = JSON.stringify(cfg, null, 2);
}

function _buildClaudeDesktopConfig(mainUrl) {
  return {
    mcpServers: {
      "ombre-brain": { url: mainUrl, type: "http" }
    }
  };
}

function onMcpModeChange() {
  const mode = document.querySelector('input[name="mcp-mode"]:checked')?.value;
  const row = document.getElementById('mcp-public-domain-row');
  if (row) row.style.display = (mode === 'public') ? '' : 'none';
  renderMcpUrls();
}

async function saveMcpAddress() {
  const msg = document.getElementById('mcp-address-msg');
  const mode = document.querySelector('input[name="mcp-mode"]:checked')?.value;
  const publicUrl = mode === 'public'
    ? (document.getElementById('mcp-custom-domain')?.value || '').trim()
    : '';
  if (mode === 'public' && !publicUrl) {
    msg.style.color = 'var(--negative)';
    msg.textContent = '请先填写公网 HTTPS 地址';
    return;
  }
  try {
    const response = await authFetch('/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({deployment: {public_url: publicUrl}, persist: true}),
    });
    if (!response) return;
    const data = await readJsonSafe(response);
    if (!response.ok || !data.ok) throw new Error(data.error || '保存失败');
    const savedUrl = String((data.deployment || {}).public_url || '');
    const input = document.getElementById('mcp-custom-domain');
    if (input) input.value = savedUrl;
    msg.style.color = data.restart_required ? 'var(--warning)' : 'var(--positive)';
    msg.textContent = (savedUrl ? ('已保存：' + savedUrl) : '已切回本地模式并清除公网地址')
      + (data.restart_required ? '；重启服务后生效' : '');
    setRestartRequired(!!data.restart_required, 'MCP 连接地址已保存');
    renderMcpUrls();
  } catch (error) {
    msg.style.color = 'var(--negative)';
    msg.textContent = error.message || String(error);
  }
}

function copyMcpUrl(which) {
  const el = document.getElementById('mcp-url-main');
  const text = el?.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const msg = document.getElementById('mcp-copy-msg');
    if (msg) { msg.textContent = '已复制 ' + text; setTimeout(() => { msg.textContent = ''; }, 2500); }
  });
}

function copyAllMcpUrls() {
  const main = document.getElementById('mcp-url-main')?.textContent || '';
  navigator.clipboard.writeText(main).then(() => {
    const msg = document.getElementById('mcp-copy-msg');
    if (msg) { msg.textContent = '已复制 /mcp 链接'; setTimeout(() => { msg.textContent = ''; }, 2500); }
  });
}

function exportClaudeDesktopConfig() {
  const mainUrl = document.getElementById('mcp-url-main')?.textContent || '';
  const cfg = _buildClaudeDesktopConfig(mainUrl);
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'claude_desktop_config.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ========================================
// 记忆包迁移（zip 导入）
// ========================================

// 冲突决策表：{bucket_id: "skip"|"overwrite"|"keep_both"}
let _migrateDecisions = {};
let _migratePollingTimer = null;
let _migrateJobId = '';

function handleMigrateFileDrop(event) {
  const files = event.dataTransfer.files;
  if (files && files.length > 0) uploadMigrateZip(files[0]);
}
function handleMigrateFileSelect(event) {
  const files = event.target.files;
  if (files && files.length > 0) uploadMigrateZip(files[0]);
}

async function uploadMigrateZip(file) {
  if (!file.name.endsWith('.zip')) {
    alert('请选择 .zip 格式的导出文件 / Please select a .zip export file');
    return;
  }
  document.getElementById('migrate-upload-zone').innerHTML =
    '<div style="font-size:12px;color:var(--text-dim);">解析中… ' + esc(file.name) + '</div>';

  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch(BASE + '/api/migrate/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!d.ok) {
      alert('解析失败：' + (d.error || '未知错误'));
      resetMigrate();
      return;
    }
    renderMigrateParsed(d);
  } catch (e) {
    alert('上传失败：' + e.message);
    resetMigrate();
  }
}

function renderMigrateParsed(d) {
  _migrateDecisions = {};
  _migrateJobId = String(d.job_id || '');
  document.getElementById('migrate-upload-zone').style.display = 'none';
  const panel = document.getElementById('migrate-parsed-panel');
  panel.style.display = 'block';
  document.getElementById('migrate-progress-panel').style.display = 'none';

  const embMatch = d.embedding_match;
  const importModel = d.import_model || '（未知）';
  const currentModel = d.current_model || '（未知）';
  const hasEmb = d.has_embeddings;

  let infoHtml = d.integrity_verified
    ? `<span style="color:var(--positive)">${_SV.ok} 备份清单与 SHA-256 校验通过。</span> `
    : `<span style="color:var(--negative)">${_SV.warn} ${esc(d.integrity_warning || '旧版备份没有完整性清单，无法确认是否齐全。')}</span> `;
  if (d.integrity_verified && d.integrity_warning) {
    infoHtml += `<span style="color:var(--negative)">${_SV.warn} ${esc(d.integrity_warning)}</span> `;
  }
  infoHtml += `解析到 <strong>${Number(d.total_buckets || 0)}</strong> 个 bucket。`;
  if (hasEmb) {
    if (embMatch) {
      infoHtml += ` <span style="color:var(--positive)">${_SV.ok} Embedding 模型一致（${esc(importModel)}），向量数据将一并导入。</span>`;
    } else {
      infoHtml += ` <span style="color:var(--negative)">${_SV.warn} Embedding 模型不一致：导入包 <code>${esc(importModel)}</code> vs 当前 <code>${esc(currentModel)}</code>。向量数据将被丢弃，导入后自动重新向量化。</span>`;
    }
  } else {
    infoHtml += ' 导入包不含向量数据，导入后将自动重新向量化。';
  }
  document.getElementById('migrate-parse-info').innerHTML = infoHtml;

  const conflicts = d.conflicts || [];
  const conflictSec = document.getElementById('migrate-conflicts-section');
  if (conflicts.length === 0) {
    conflictSec.style.display = 'none';
  } else {
    conflictSec.style.display = 'block';
    const list = document.getElementById('migrate-conflicts-list');
    list.innerHTML = conflicts.map(c => {
      const bid = escAttr(c.bucket_id);
      return `<div style="background:var(--surface);border-radius:8px;padding:8px 10px;margin:4px 0;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${bid}">${esc(c.import_name)}</div>
            <div style="color:var(--text-dim);font-size:11px;">导入: ${esc(c.import_created)} &nbsp;|&nbsp; 当前: <em>${esc(c.current_name)}</em> (${esc(c.current_created)})</div>
          </div>
          <select data-bucket-id="${escAttr(c.bucket_id)}"

            style="font-size:12px;padding:2px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface-solid);color:var(--text);" data-ob-change="_migrateDecisions%5Bthis.dataset.bucketId%5D%3Dthis.value">
            <option value="skip" selected>跳过（保留当前）</option>
            <option value="overwrite">覆盖（用导入替换当前）</option>
            <option value="keep_both">保留两者（分配新 ID）</option>
          </select>
        </div>
      </div>`;
    }).join('');
  }
}

async function applyMigrate() {
  document.getElementById('migrate-parsed-panel').style.display = 'none';
  document.getElementById('migrate-progress-panel').style.display = 'block';
  document.getElementById('migrate-phase-text').textContent = '正在导入…';
  document.getElementById('migrate-progress-bar').style.width = '0%';

  try {
    const r = await fetch(BASE + '/api/migrate/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions: _migrateDecisions, job_id: _migrateJobId }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      document.getElementById('migrate-phase-text').textContent = '启动失败：' + (d.error || r.status);
      return;
    }
  } catch (e) {
    document.getElementById('migrate-phase-text').textContent = '请求失败：' + e.message;
    return;
  }

  // 开始轮询状态
  _migratePollingTimer = setInterval(pollMigrateStatus, 1200);
}

async function pollMigrateStatus() {
  try {
    const r = await fetch(BASE + '/api/migrate/status');
    const d = await r.json();
    if (_migrateJobId && d.job_id && d.job_id !== _migrateJobId) {
      clearInterval(_migratePollingTimer);
      _migratePollingTimer = null;
      document.getElementById('migrate-phase-text').textContent = '任务已被新的迁移包替代，请重新上传';
      return;
    }
    updateMigrateProgress(d);
    if (d.phase === 'done' || d.phase === 'error') {
      clearInterval(_migratePollingTimer);
      _migratePollingTimer = null;
    }
  } catch (e) {
    // 网络抖动，继续轮询
  }
}

function updateMigrateProgress(d) {
  const phaseNames = {
    idle: '空闲', parsing: '正在解析…', parsed: '已解析', applying: '正在写入…',
    reindexing: '重新向量化…', done: '完成', error: '出错',
  };
  const phaseText = document.getElementById('migrate-phase-text');
  phaseText.textContent = phaseNames[d.phase] || d.phase;
  phaseText.style.color = d.phase === 'error' ? 'var(--negative)' : 'var(--text-dim)';

  let pct = 0;
  let countText = '';
  if (d.phase === 'applying' && d.apply_progress && d.apply_progress.total > 0) {
    pct = Math.round(d.apply_progress.done / d.apply_progress.total * 100);
    countText = `${d.apply_progress.done} / ${d.apply_progress.total}`;
  } else if (d.phase === 'reindexing' && d.reindex_progress && d.reindex_progress.total > 0) {
    pct = Math.round(d.reindex_progress.done / d.reindex_progress.total * 100);
    countText = `向量化 ${d.reindex_progress.done} / ${d.reindex_progress.total}`;
  } else if (d.phase === 'done') {
    pct = 100;
    const res = d.result || {};
    countText = `已导入 ${res.imported || 0} 条，跳过 ${res.skipped || 0} 条`;
  }
  document.getElementById('migrate-progress-bar').style.width = pct + '%';
  document.getElementById('migrate-count-text').textContent = countText;

  if (d.phase === 'done') {
    const res = d.result || {};
    document.getElementById('migrate-result-text').textContent =
      `导入完成：${res.imported || 0} 条写入，${res.skipped || 0} 条跳过。`;
  } else if (d.phase === 'error') {
    document.getElementById('migrate-result-text').textContent = '错误：' + (d.error || '');
  }

  const errs = (d.apply_errors || []);
  document.getElementById('migrate-errors-text').textContent = errs.length ? errs.join('\n') : '';
}

function resetMigrate() {
  if (_migratePollingTimer) { clearInterval(_migratePollingTimer); _migratePollingTimer = null; }
  _migrateDecisions = {};
  _migrateJobId = '';
  const zone = document.getElementById('migrate-upload-zone');
  zone.style.display = 'block';
  zone.innerHTML = '<div style="font-size:13px;color:var(--text-dim);">点击或拖入 <code>ombre_export_*.zip</code></div><input type="file" id="migrate-file-input" accept=".zip" style="display:none" / data-ob-change="handleMigrateFileSelect%28event%29">';
  document.getElementById('migrate-parsed-panel').style.display = 'none';
  document.getElementById('migrate-progress-panel').style.display = 'none';
}

async function loadDuplicates() {
  const box = document.getElementById('duplicates-list');
  box.innerHTML = '<div class="loading">加载中… / Loading…</div>';
  try {
    const r = await fetch(BASE + '/api/duplicates');
    const d = await r.json();
    const pairs = d.pairs || [];
    if (!pairs.length) { box.innerHTML = '<p style="color:var(--text-dim)">没有发现疑似重复桶。</p>'; return; }
    box.innerHTML = pairs.map(p => `
      <div style="background:var(--surface);border-radius:10px;padding:10px;margin:6px 0;">
        <div style="font-size:12px;color:var(--text-dim);">相似度 ${p.score ? p.score.toFixed(3) : '—'}</div>
        <div style="margin:4px 0;"><a href="#" data-bucket-id="${escAttr(p.a.id)}" data-ob-click="showDetail%28this.dataset.bucketId%29%3Breturn%20false%3B">${esc(p.a.name || p.a.id)}</a> ⟷ <a href="#" data-bucket-id="${escAttr(p.b.id)}" data-ob-click="showDetail%28this.dataset.bucketId%29%3Breturn%20false%3B">${esc(p.b.name || p.b.id)}</a></div>
      </div>
    `).join('');
  } catch (e) { box.innerHTML = '<p style="color:var(--negative)">加载失败: ' + esc(e.message) + '</p>'; }
}

// ========================================
// iter 1.6 §6 — trace 编辑表单（注入到 detail 面板）
// 在 showDetail 渲染完后调用，给「编辑」按钮挂事件
// ========================================
function renderEditForm(bid, meta) {
  const curContent = esc(meta._content_for_edit || '');
  const fallbackTitle = String(meta.name || '').replace(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\s*/, '');
  const editTitle = String(meta.title || fallbackTitle || '');
  const safeImportance = Math.round(safeNumber(meta.importance, 5, 1, 10));
  const editableTypes = ['dynamic','permanent','feel','plan','letter'];
  const currentType = String(meta.type || 'dynamic');
  const typeIsEditable = editableTypes.indexOf(currentType) !== -1;
  // BucketManager 对“解除钉选”采用确定性的 permanent → dynamic 迁移。
  // 钉选状态下只展示这条可原子保存的路径，避免 UI 承诺后端会拒绝的
  // permanent → feel/plan/letter 一步迁移；解钉保存后即可继续改为其他类型。
  const typeOptions = meta.pinned && typeIsEditable
    ? ['permanent', 'dynamic']
    : (typeIsEditable ? editableTypes : [currentType].concat(editableTypes));
  return `
    <details id="bucket-edit-form" style="margin-top:14px;border:1px solid var(--border);border-radius:2px;padding:12px 14px;background:var(--surface-solid);">
      <summary style="cursor:pointer;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:5px;"><svg class="icon" aria-hidden="true"><use href="#i-edit"></use></svg> 编辑这条记忆</summary>
      <div style="display:grid;grid-template-columns:90px 1fr;gap:10px 12px;align-items:center;margin-top:14px;font-size:13px;">
        <label>标题</label>
        <input id="edit-title" type="text" maxlength="120" value="${escAttr(editTitle)}" data-dirty="0" placeholder="原文核对使用的精确标题" / data-ob-input="this.dataset.dirty%3D%271%27">
        <label>显示名称</label>
        <input id="edit-name" type="text" value="${escAttr(meta.name || '')}" />
        <label>类型</label>
        <select id="edit-type" style="width:160px;" ${typeIsEditable ? '' : 'disabled title="特殊类型由对应工具维护，编辑其他字段时会保持原类型"'} data-ob-change="syncEditPinConstraints%28%27type%27%29">
          ${typeOptions.map(t =>
            `<option value="${escAttr(t)}" ${currentType === t ? 'selected' : ''}>${esc(t)}</option>`
          ).join('')}
        </select>
        ${typeIsEditable ? '' : '<span></span><small style="color:var(--text-dim);margin-top:-8px;">特殊/未知类型保持不变</small>'}
        <label>主题（domain）</label>
        <input id="edit-domain" type="text" value="${escAttr((meta.domain||[]).join(', '))}" placeholder="逗号分隔，如：工作, 心情" />
        <label>标签</label>
        <input id="edit-tags" type="text" value="${escAttr((meta.tags||[]).join(', '))}" placeholder="逗号分隔" />
        <label>重要度</label>
        <span><input id="edit-importance" type="range" min="1" max="10" value="${safeImportance}" style="vertical-align:middle;" / data-ob-input="document.getElementById%28%27edit-imp-val%27%29.textContent%3Dthis.value%3BsyncEditPinConstraints%28%27importance%27%29"> <span id="edit-imp-val">${safeImportance}</span>/10</span>
        <label>已解决</label>
        <span><input id="edit-resolved" type="checkbox" ${meta.resolved ? 'checked' : ''} /> <small style="color:var(--text-dim);">勾上后仅在关键词命中时重现（适合已闭环的 plan / 事件）</small></span>
        <label>钉选</label>
        <span><input id="edit-pinned" type="checkbox" ${meta.pinned ? 'checked' : ''} / data-ob-change="syncEditPinConstraints%28%27pinned%27%29"> <small id="edit-pin-hint" style="color:var(--text-dim);">钉选会同步为 permanent / importance=10</small></span>
        <label>已消化</label>
        <span><input id="edit-digested" type="checkbox" ${meta.digested ? 'checked' : ''} /></span>
        <label>主动遗忘</label>
        <span><input id="edit-dont-surface" type="checkbox" ${meta.dont_surface ? 'checked' : ''} /> <small style="color:var(--text-dim);">不在 breath 中主动浮现（桁仍保留）</small></span>
        <label style="align-self:start;padding-top:8px;">为什么记得</label>
        <textarea id="edit-why" placeholder="可选：这条为什么值得保留（仅展示，不计分）" style="min-height:50px;font-family:inherit;line-height:1.7;resize:vertical;">${esc(meta.why_remembered || '')}</textarea>
        ${meta.type === 'plan' ? `<label>承诺重量</label>
        <span>
          <input id="edit-weight" type="range" min="0" max="100" value="${Math.round((meta.weight||0)*100)}" list="weight-anchors" style="vertical-align:middle;width:200px;" / data-ob-input="window._updateWeightLabel%20%26%26%20window._updateWeightLabel%28this.value%29">
          <datalist id="weight-anchors"><option value="25"></option><option value="50"></option><option value="75"></option><option value="100"></option></datalist>
          <span id="edit-weight-val" style="margin-left:8px;">${Math.round((meta.weight||0)*100)}% · ${weightAnchorLabel((meta.weight||0))}</span>
          <small style="color:var(--text-dim);display:block;margin-top:4px;">轻 25% · 中 50% · 重 75% · 必须 100%（0–100%，仅用于排序展示）</small>
        </span>` : ''}
        <label for="edit-content" style="align-self:start;padding-top:8px;">正文</label>
        <textarea id="edit-content" aria-label="正文 / Content" placeholder="留空不改" style="min-height:120px;font-family:inherit;line-height:1.7;resize:vertical;">${curContent}</textarea>
      </div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
        <button class="btn-primary" data-bucket-id="${escAttr(bid)}" title="保存修改" style="padding:0 14px;height:36px;display:inline-flex;align-items:center;gap:5px;" data-ob-click="bucketSaveEdit%28this.dataset.bucketId%29"><i data-lucide="check"></i> 保存修改</button>
        <span id="edit-msg" style="font-size:12px;"></span>
      </div>
    </details>`;
}

function syncEditPinConstraints(source) {
  const pinnedEl = document.getElementById('edit-pinned');
  const typeEl = document.getElementById('edit-type');
  const importanceEl = document.getElementById('edit-importance');
  const importanceValueEl = document.getElementById('edit-imp-val');
  const hintEl = document.getElementById('edit-pin-hint');
  // i/self、archived 等受保护类型不通过普通编辑器改变生命周期约束。
  if (!pinnedEl || !typeEl || typeEl.disabled) return;

  if (source === 'pinned' && pinnedEl.checked) {
    typeEl.value = 'permanent';
    if (importanceEl) importanceEl.value = '10';
    if (importanceValueEl) importanceValueEl.textContent = '10';
    if (hintEl) {
      hintEl.textContent = '已同步为 permanent / importance=10';
      hintEl.style.color = 'var(--accent)';
    }
    return;
  }

  const typeAllowsPin = typeEl.value === 'permanent';
  const importanceAllowsPin = !importanceEl || Number(importanceEl.value) >= 10;
  if (pinnedEl.checked && (!typeAllowsPin || !importanceAllowsPin)) {
    pinnedEl.checked = false;
    if (hintEl) {
      hintEl.textContent = '已自动取消钉选；类型和重要度可在本次一并保存';
      hintEl.style.color = 'var(--accent)';
    }
  }
}

async function bucketSaveEdit(bid) {
  // 事件联动之外再做一次保存前校验，避免脚本赋值或浏览器差异留下矛盾字段。
  syncEditPinConstraints('save');
  const newContent = document.getElementById('edit-content').value;
  // iter 1.8: 新增 why_remembered / dont_surface / weight，plan 才会有 weight
  const weightEl = document.getElementById('edit-weight');
  const typeEl = document.getElementById('edit-type');
  const titleEl = document.getElementById('edit-title');
  const body = {
    name: document.getElementById('edit-name').value,
    tags: document.getElementById('edit-tags').value,
    domain: document.getElementById('edit-domain').value,
    importance: parseInt(document.getElementById('edit-importance').value, 10),
    resolved: document.getElementById('edit-resolved').checked,
    pinned: document.getElementById('edit-pinned').checked,
    digested: document.getElementById('edit-digested').checked,
    dont_surface: document.getElementById('edit-dont-surface').checked,
    why_remembered: document.getElementById('edit-why').value,
  };
  // 历史桶可能没有显式 title；表单展示的是 name fallback。只有用户
  // 真正动过标题输入框才提交，避免保存其他字段时意外固化或因空标题 400。
  if (titleEl && titleEl.dataset.dirty === '1') body.title = titleEl.value;
  // i/self、archived 及未来特殊类型由专用生命周期维护；不要把浏览器
  // select 的默认首项 dynamic 写回。普通类型仍允许沿用现有编辑入口。
  if (typeEl && !typeEl.disabled) body.type = typeEl.value;
  if (weightEl) body.weight = parseFloat(weightEl.value) / 100;
  // 内容只在非空时带上，避免误清空
  if (newContent && newContent.trim()) body.content = newContent;
  const msg = document.getElementById('edit-msg');
  const importView = document.getElementById('import-view');
  const refreshImportResults = importView && importView.style.display !== 'none';
  const importList = document.getElementById('import-results-list');
  const importScrollTop = importList ? importList.scrollTop : 0;
  const detailGenerationAtSave = detailLoadGeneration;
  msg.textContent = '保存中… / Saving…';
  msg.style.color = 'var(--text-dim)';
  try {
    const r = await fetch(BASE + '/api/bucket/' + encodeURIComponent(bid) + '/edit', {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    msg.innerHTML = _SV.ok + ' 已保存：' + esc((d.updated || []).join(', '));
    msg.style.color = 'var(--accent)';
    // If the user opened/closed another detail while PATCH was in flight, do
    // not pull the panel back to the bucket that just finished saving.
    if (detailLoadGeneration === detailGenerationAtSave) {
      await showDetail(bid);
    }
    await loadBuckets();
    if (refreshImportResults) {
      await loadImportResults({preserveScroll:true, scrollTop:importScrollTop});
    }
  } catch (e) {
    msg.innerHTML = _SV.err + ' ' + esc(e.message);
    msg.style.color = 'var(--negative)';
  }
}

// ========================================
// iter 1.6 §8 — onboarding 首启引导 + embedding 警告
// ========================================
async function maybeShowOnboarding() {
  try {
    const r = await fetch(BASE + '/api/onboarding/status');
    const d = await readJsonSafe(r);
    if (d.first_run) {
      document.getElementById('onboarding-overlay').style.display = 'flex';
    }
    const banner = document.getElementById('embed-warn-banner');
    if (banner) banner.classList.toggle('show', !d.embedding_enabled);
  } catch (e) { /* 静默 */ }
}
function dismissOnboarding() {
  document.getElementById('onboarding-overlay').style.display = 'none';
}
function gotoEmbedCloud() {
  document.querySelector('[data-tab=settings]')?.click();
  setTimeout(() => {
    const el = document.getElementById('cfg-emb-api-key');
    if (el) { ensureSettingsGroupFor(el); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
  }, 250);
}
function gotoEmbedLocal() {
  document.querySelector('[data-tab=settings]')?.click();
  setTimeout(() => {
    const el = document.getElementById('local-emb-status');
    if (el) { ensureSettingsGroupFor(el); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }, 250);
}

// ========================================
// Letters tab — 合并自原 letters.html
// ========================================
let _lettersCache = [];

// ========================================
// iter 2.0: Anchor counter + view
// ========================================
async function refreshAnchorCounter() {
  try {
    const resp = await authFetch('/api/anchors');
    if (!resp || !resp.ok) return;
    const d = await resp.json();
    const el = document.getElementById('anchor-counter-text');
    if (el) el.textContent = `${d.count}/${d.limit}`;
    // 满额（24/24）→ 锚图标变沉，像「压舱物已经很重了」
    const wrap = document.getElementById('anchor-counter');
    if (wrap) {
      const full = d.limit && d.count >= d.limit;
      wrap.classList.toggle('full', !!full);
      wrap.title = full ? 'anchor 已满（' + d.count + '/' + d.limit + '）— 要 anchor 新的，得先 release 一条旧的' : 'anchor = 坐标系桶，硬上限 ' + d.limit;
    }
    return d;
  } catch(e) { /* ignore */ }
}
function _escapeAnchorHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function loadAnchorsView() {
  const list = document.getElementById('anchors-list');
  const cnt = document.getElementById('anchors-count-text');
  list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">加载中… / Loading…</div>';
  try {
    const resp = await authFetch('/api/anchors');
    if (!resp || !resp.ok) { list.innerHTML = '<div style="color:#c33;">加载失败</div>'; return; }
    const d = await resp.json();
    cnt.innerHTML = `<b>${Number(d.count || 0)}</b> / ${Number(d.limit || 0)} 槽已用`;
    if (d.count === 0) {
      list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:14px 0;">还没有 anchor。在桶详情页用 ' + _SV.anchor + ' 按钮把一条「定义我们是谁」的事实钉为坐标系。</div>';
      refreshAnchorCounter();
      return;
    }
    list.innerHTML = d.anchors.map((a, i) => `
      <div data-bucket-id="${escAttr(a.id)}" style="background:var(--surface);border-radius:var(--radius-inner);padding:12px 16px;display:flex;align-items:center;gap:12px;box-shadow:4px 4px 10px var(--shadow-dark-subtle),-3px -3px 8px var(--shadow-light);cursor:pointer;" data-ob-click="showDetail%28this.dataset.bucketId%29">
        <div style="font-family:'Cormorant Garamond',serif;font-size:18px;color:var(--accent);min-width:28px;flex-shrink:0;">${String(i+1).padStart(2,'0')}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${_escapeAnchorHtml(a.name || a.id)}
            ${a.pinned ? '<span style="font-size:10px;color:var(--accent);margin-left:6px;">⊕ pinned</span>' : ''}
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${_escapeAnchorHtml(a.preview || '')}</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:4px;">created: ${esc(a.created || '')}</div>
        </div>
        <button class="btn-secondary" data-bucket-id="${escAttr(a.id)}" title="释放 anchor" style="flex-shrink:0;padding:6px 10px;font-size:11px;" data-ob-click="event.stopPropagation%28%29%3BreleaseAnchor%28this.dataset.bucketId%29">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="10" height="7" rx="1.5"/><path d="M5 8V5a3 3 0 0 1 6 0"/></svg>
        </button>
      </div>
    `).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    refreshAnchorCounter();
  } catch(e) {
    list.innerHTML = `<div style="color:#c33;">加载失败：${esc(e && e.message ? e.message : e)}</div>`;
  }
}
async function toggleAnchor(bucketId, value) {
  try {
    const resp = await authFetch(`/api/bucket/${encodeURIComponent(bucketId)}/anchor`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(value === undefined ? {} : {value: value}),
    });
    if (!resp) return null;
    const body = await resp.json();
    if (resp.status === 409) {
      alert(`anchor 已满 ${body.limit}/${body.limit}。\n\n如果这条新的比某条旧的更核心，先去 Anchor 面板 release 那条旧的。\n\n（痛是结构在工作。anchor 是稀缺的。）`);
      return body;
    }
    if (!resp.ok) {
      alert(`anchor 操作失败：${body.error || resp.status}`);
      return body;
    }
    refreshAnchorCounter();
    return body;
  } catch(e) {
    alert(`anchor 操作失败：${e}`);
    return null;
  }
}
async function releaseAnchor(bucketId) {
  await toggleAnchor(bucketId, false);
  loadAnchorsView();
}

async function loadLetters() {
  const filter = document.getElementById('letter-filter').value;
  const list = document.getElementById('letters-list');
  const cnt = document.getElementById('letter-count');
  list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px;">加载中… / Loading…</div>';
  try {
    const url = BASE + '/api/letters' + (filter ? '?author=' + encodeURIComponent(filter) : '');
    const r = await fetch(url);
    const d = await r.json();
    _lettersCache = d.letters || [];
    cnt.textContent = _lettersCache.length + ' 封';
    if (!_lettersCache.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:36px 0;">尚无信件</div>';
      return;
    }
    list.innerHTML = _lettersCache.map(_renderLetter).join('');
  } catch (e) {
    list.innerHTML = '<div style="color:var(--negative);padding:18px;">加载失败：' + esc(e.message) + '</div>';
  }
}

function _renderLetter(l) {
  // 用户侧显示 user_name；AI 侧（及任意自定义署名）原样显示存储的 author 值。
  const who = l.author === 'user' ? (l.user_name || 'user') : (l.author || 'AI');
  const accentColor = l.author !== 'user' ? 'var(--accent)' : 'var(--text-dim)';
  return `<article style="background:var(--surface);border:1px solid var(--border);border-radius:2px;padding:18px 22px;box-shadow:4px 4px 10px var(--shadow-dark-subtle), -4px -4px 10px var(--shadow-light);" data-id="${escAttr(l.id)}">
    <div style="font-size:11px;color:var(--text-dim);letter-spacing:0.15em;display:flex;justify-content:space-between;margin-bottom:8px;">
      <span style="color:${accentColor};font-weight:600;">${esc(who)}</span><span>${esc(l.date || '')}</span>
    </div>
    ${l.title ? `<div style="font-family:'Cormorant Garamond', serif;font-size:17px;font-weight:600;margin-bottom:8px;color:var(--text);">${esc(l.title)}</div>` : ''}
    <div style="white-space:pre-wrap;font-size:14px;line-height:1.75;color:var(--text);">${esc(l.content || '')}</div>
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;font-size:11px;">
      <button data-letter-id="${escAttr(l.id)}" title="编辑" style="padding:4px 9px;background:transparent;border:1px solid var(--border);color:var(--text-dim);border-radius:2px;cursor:pointer;display:inline-flex;align-items:center;" data-ob-click="editLetter%28this.dataset.letterId%29"><i data-lucide="pencil" style="width:13px;height:13px;"></i></button>
      <button data-letter-id="${escAttr(l.id)}" title="删除" style="padding:4px 9px;background:transparent;border:1px solid var(--border);color:var(--accent);border-radius:2px;cursor:pointer;display:inline-flex;align-items:center;" data-ob-click="deleteLetter%28this.dataset.letterId%29"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
    </div>
  </article>`;
}

async function sendLetter() {
  const status = document.getElementById('letter-status');
  status.style.color = 'var(--text-dim)';
  status.textContent = '...';
  const body = {
    author: document.getElementById('letter-author').value,
    user_name: document.getElementById('letter-username').value,
    title: document.getElementById('letter-title').value,
    date: document.getElementById('letter-date').value,
    content: document.getElementById('letter-content').value,
  };
  if (!body.content.trim()) {
    status.style.color = 'var(--negative)'; status.textContent = '内容为空';
    return;
  }
  try {
    const r = await fetch(BASE + '/api/letter', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) {
      status.style.color = 'var(--accent)';
      status.innerHTML = _SV.ok + ' 已寄出 · ' + esc(d.id);
      document.getElementById('letter-content').value = '';
      document.getElementById('letter-title').value = '';
      loadLetters();
    } else {
      status.style.color = 'var(--negative)';
      status.innerHTML = _SV.err + ' ' + esc(d.error || '失败');
    }
  } catch (e) {
    status.style.color = 'var(--negative)';
    status.innerHTML = _SV.err + ' ' + esc(e.message);
  }
}

async function editLetter(id) {
  const l = _lettersCache.find(x => x.id === id);
  if (!l) { alert('未找到该信件 / Letter not found'); return; }
  const newTitle = prompt('标题（留空则不改）：', l.title || '');
  if (newTitle === null) return;
  const newDate = prompt('日期 YYYY-MM-DD（留空则不改）：', l.date || '');
  if (newDate === null) return;
  const newContent = prompt('内容（留空则不改）：', l.content || '');
  if (newContent === null) return;
  const body = {};
  if (newTitle !== (l.title || '') && newTitle !== '') body.title = newTitle;
  if (newDate !== (l.date || '') && newDate !== '') body.date = newDate;
  if (newContent !== (l.content || '') && newContent.trim() !== '') body.content = newContent;
  if (!Object.keys(body).length) { alert('未做任何修改 / No changes made'); return; }
  if (!confirm('确认保存修改？ / Save changes?')) return;
  try {
    const r = await fetch(BASE + '/api/letter/' + encodeURIComponent(id), {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) { alert('已更新 / Updated'); loadLetters(); }
    else { alert(d.error || '更新失败'); }
  } catch (e) { alert(e.message); }
}

async function deleteLetter(id) {
  if (!confirm('这会把这封信移入删除档案；文件仍保留在 archive/ 中。继续？\n\nThis moves the letter to the delete archive; the file stays in archive/. Continue?')) return;
  if (!confirm('再次确认：这不是物理抹除。 / Confirm again: this is not a physical erase.')) return;
  try {
    const r = await fetch(BASE + '/api/letter/' + encodeURIComponent(id) + '?confirm=true', { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) { alert('已删除到档案 / Moved to archive'); loadLetters(); }
    else { alert(d.error || '删除失败'); }
  } catch (e) { alert(e.message); }
}

// ── E/F 级错误自动弹窗 ────────────────────────────────────────
// 每 60s 轮询 /api/errors/recent?min_level=E，若有新条目则弹窗提示。
// 用 localStorage 存最后确认时间戳，避免重复打扰。

async function pollCriticalErrors() {
  try {
    const r = await fetch(BASE + '/api/errors/recent?min_level=E&limit=20');
    if (!r.ok) return;
    const d = await r.json();
    const items = (d.errors || []).filter(function(it) {
      return it.level === 'E' || it.level === 'F';
    });
    if (!items.length) return;
    // 取最新一条的时间戳
    const latest = items[0].ts || '';
    const lastSeen = localStorage.getItem('ob_error_last_seen') || '';
    if (latest && latest <= lastSeen) return;
    showErrorAlertPopup(items, latest);
  } catch (_) { /* 轮询失败静默，不干扰主功能 */ }
}

function showErrorAlertPopup(items, latestTs) {
  var popup = document.getElementById('error-alert-popup');
  var body = document.getElementById('error-alert-body');
  if (!popup || !body) return;

  var html = items.slice(0, 5).map(function(it) {
    var st = _obLevelStyle(it.level || 'E');
    return (
      '<div style="border:1px solid ' + st.border + ';background:' + st.bg +
      ';border-radius:3px;padding:10px 12px;margin-bottom:8px;">' +
      '<div style="display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;">' +
        '<span style="color:' + st.color + ';font-weight:700;">' + st.label + '</span>' +
        '<code style="font-family:Menlo,monospace;color:var(--text);font-size:11px;">' + esc(it.code || '?') + '</code>' +
        '<span style="color:var(--text);font-weight:500;">' + esc(it.title || '') + '</span>' +
        '<span style="margin-left:auto;color:var(--text-dim);font-size:10px;">' + esc(it.ts || '') + '</span>' +
      '</div>' +
      (it.detail ? '<div style="font-size:12px;color:var(--text-dim);margin-top:6px;line-height:1.6;">' + esc(it.detail) + '</div>' : '') +
      '</div>'
    );
  }).join('');

  if (items.length > 5) {
    html += '<div style="font-size:12px;color:var(--text-dim);text-align:center;padding-top:4px;">…还有 ' + (items.length - 5) + ' 条，前往「日志」Tab 查看全部</div>';
  }
  body.innerHTML = html;
  popup.style.display = 'flex';
  // 记录最新已展示时间戳
  if (latestTs) localStorage.setItem('ob_error_last_seen', latestTs);
}

function closeErrorAlertPopup() {
  var popup = document.getElementById('error-alert-popup');
  if (popup) popup.style.display = 'none';
}

function goToLogsTab() {
  closeErrorAlertPopup();
  var t = document.querySelector('.tab[data-tab="logs"]');
  if (t) t.click();
}

// 认证完成后刷新当前视图；也支持 #letters 老书签直达。
// 这里不能在脚本解析阶段直接 click，否则未登录访问会抢跑受保护接口。
function refreshAuthenticatedActiveView() {
  let target = null;
  if (location.hash === '#letters') {
    target = document.querySelector('.tab[data-tab="letters"]');
  }
  if (!target) target = document.querySelector('.tab.active');
  if (target) return activateDashboardTab(target);
  return Promise.resolve([]);
}

// ── 给作者反馈 ──────────────────────────────────────────────
async function openFeedback() {
  const modal = document.getElementById('feedback-modal');
  modal.style.display = 'flex';
  document.getElementById('feedback-log-area').textContent = '加载中… / Loading…';
  try {
    const r = await fetch(BASE + '/api/logs?limit=30');
    const d = await r.json();
    document.getElementById('feedback-log-area').textContent =
      d.lines ? d.lines.join('\n') : (d.error || '（无日志）');
  } catch (e) {
    document.getElementById('feedback-log-area').textContent = '加载失败: ' + e.message;
  }
}
function closeFeedback() {
  document.getElementById('feedback-modal').style.display = 'none';
}
function copyFeedback() {
  const type = document.getElementById('feedback-type').value;
  const desc = document.getElementById('feedback-desc').value.trim();
  const logs = document.getElementById('feedback-log-area').textContent;
  const text = `问题类型: ${type}\n描述: ${desc || '（未填写）'}\n\n--- 最近日志（30条）---\n${logs}`;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('feedback-copy-btn');
    btn.innerHTML = _SV.ok + ' 已复制';
    setTimeout(() => { btn.textContent = '一键复制'; }, 2000);
  });
}



// ============================================================
// Human name setting
// ============================================================
async function loadHumanName() {
  try {
    var res = await fetch(BASE + '/api/settings/human');
    if (res.ok) {
      var data = await res.json();
      var el = document.getElementById('settings-human-name');
      if (el) el.value = data.human || '';
    }
  } catch (e) { /* silent */ }
}

async function saveHumanName() {
  var el = document.getElementById('settings-human-name');
  var msg = document.getElementById('settings-human-msg');
  var name = (el ? el.value.trim() : '') || '人类';
  try {
    var res = await fetch(BASE + '/api/settings/human', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ human: name }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    var changed = (data.renamed && data.renamed.buckets_changed) || 0;
    if (msg) {
      msg.textContent = changed > 0 ? ('已保存，并同步了 ' + changed + ' 条旧记忆') : '已保存';
      msg.style.color = 'var(--positive)';
    }
    setTimeout(function() { if (msg) msg.textContent = ''; }, 4000);
  } catch (e) {
    if (msg) { msg.textContent = '保存失败：' + e.message; msg.style.color = 'var(--negative)'; }
  }
}

async function syncExistingHuman() {
  var fromEl = document.getElementById('settings-human-from');
  var msg = document.getElementById('settings-human-sync-msg');
  var from = fromEl ? fromEl.value.trim() : '';
  if (!from) from = '用户';
  if (msg) { msg.textContent = '替换中… / Replacing…'; msg.style.color = 'var(--text-dim)'; }
  try {
    var res = await fetch(BASE + '/api/settings/human/sync-existing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from }),
    });
    var data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    if (data.note) {
      if (msg) { msg.textContent = data.note; msg.style.color = 'var(--text-dim)'; }
      return;
    }
    var changed = (data.renamed && data.renamed.buckets_changed) || 0;
    if (msg) {
      msg.textContent = changed > 0
        ? ('已把「' + data.from + '」→「' + data.to + '」，更新了 ' + changed + ' 条记忆')
        : ('没有找到含「' + data.from + '」的旧记忆');
      msg.style.color = changed > 0 ? 'var(--positive)' : 'var(--text-dim)';
    }
  } catch (e) {
    if (msg) { msg.textContent = '替换失败：' + e.message; msg.style.color = 'var(--negative)'; }
  }
}



// ====== Self / I panel ======
let _selfEntries = [];
let _selfAspectFilter = '';

async function openSelfPanel() {
  document.getElementById('self-panel').classList.add('open');
  document.getElementById('self-overlay').classList.add('show');
  await loadSelfEntries();
  if (window.lucide) lucide.createIcons();
}

function closeSelfPanel() {
  document.getElementById('self-panel').classList.remove('open');
  document.getElementById('self-overlay').classList.remove('show');
}

function setSelfFilter(btn) {
  document.querySelectorAll('.self-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _selfAspectFilter = btn.dataset.aspect;
  renderSelfEntries();
}

async function loadSelfEntries() {
  const body = document.getElementById('self-panel-body');
  try {
    const res = await authFetch('/api/self');
    if (!res || !res.ok) { body.innerHTML = '<div class="self-panel-empty">加载失败</div>'; return; }
    _selfEntries = await res.json();
    document.getElementById('self-fab').classList.toggle('has-entries', _selfEntries.length > 0);
    renderSelfEntries();
  } catch (e) {
    body.innerHTML = '<div class="self-panel-empty">' + esc(e.message) + '</div>';
  }
}

function renderSelfEntries() {
  const body = document.getElementById('self-panel-body');
  const filtered = _selfAspectFilter
    ? _selfEntries.filter(e => e.aspect === _selfAspectFilter)
    : _selfEntries;

  if (!filtered.length) {
    body.innerHTML = '<div class="self-panel-empty">' + (_selfAspectFilter ? '该维度暂无条目' : '尚未写下任何自我认知') + '</div>';
    return;
  }

  body.innerHTML = filtered.map(e => {
    const ts = (e.created || '').slice(0, 16).replace('T', ' ');
    const aspectHtml = e.aspect
      ? '<span class="self-entry-aspect">' + esc(e.aspect) + '</span>'
      : '';
    return '<div class="self-entry">'
      + '<div class="self-entry-meta">' + aspectHtml + '<span class="self-entry-time">' + esc(ts) + '</span></div>'
      + '<div class="self-entry-content">' + esc(e.content) + '</div>'
      + '</div>';
  }).join('');
}

// 认证成功后检测是否有条目，给 FAB 加小圆点
async function initSelfFab() {
  try {
    const res = await authFetch('/api/self');
    if (res && res.ok) {
      const data = await res.json();
      const hasEntries = Array.isArray(data) && data.length > 0;
      const fab = document.getElementById('self-fab');
      if (fab) fab.classList.toggle('has-entries', hasEntries);
      _selfEntries = hasEntries ? data : [];
    }
  } catch (_) {}
}

// Dynamic dashboard fragments use data attributes instead of inline handlers so
// they continue to work under script-src 'self'.  This deliberately recognizes
// only the small, static action grammar emitted below; it never evaluates HTML.
const _OB_DYNAMIC_CALLS = new Set([
  'batchReview', 'bucketAllowOne', 'bucketAnchor', 'bucketArchive',
  'bucketDelete', 'bucketForget', 'bucketPin', 'bucketResolve',
  'bucketSaveEdit', 'deleteLetter', 'editLetter', 'gotoBucketPage',
  'gotoDiagnostics', 'handleMigrateFileSelect', 'jumpToBucketPage',
  'openImportedBucketEditor', 'planAction', 'planEdit', 'releaseAnchor',
  'replayV3Decision', 'reviewAction', 'runGithubImport',
  'selectRemoteModelOption', 'showDetail', 'syncEditPinConstraints',
  'toggleBucketSelection',
]);

function _obActionArgument(token, element, event) {
  const value = token.trim().replace(/\\'/g, "'");
  if (value === 'this') return element;
  if (value === 'event') return event;
  if (value === 'this.value') return element.value;
  if (value === 'this.checked') return element.checked;
  const dataset = /^this\.dataset\.([A-Za-z][A-Za-z0-9]*)$/.exec(value);
  if (dataset) return element.dataset[dataset[1]];
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const quoted = /^(?:'([^']*)'|"([^"]*)")$/.exec(value);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  return undefined;
}

function _obRunDynamicAction(element, event, rawAction) {
  let action;
  try {
    action = decodeURIComponent(rawAction).replace(/\\'/g, "'").trim();
  } catch (_) {
    return;
  }

  if (action.includes('event.preventDefault()') || action.includes('return false')) event.preventDefault();
  if (action.includes('event.stopPropagation()')) event.stopPropagation();
  if (action === 'this.parentNode.remove()') {
    element.parentNode?.remove();
    return;
  }
  if (action === "this.dataset.dirty='1'") {
    element.dataset.dirty = '1';
    return;
  }
  if (action === '_migrateDecisions[this.dataset.bucketId]=this.value') {
    _migrateDecisions[element.dataset.bucketId] = element.value;
    return;
  }
  if (action === "window._updateWeightLabel && window._updateWeightLabel(this.value)") {
    if (typeof window._updateWeightLabel === 'function') window._updateWeightLabel(element.value);
    return;
  }
  const background = /^this\.style\.background='([^']*)'$/.exec(action);
  if (background) {
    element.style.background = background[1];
    return;
  }
  const labelAndConstraint = /^document\.getElementById\('([^']+)'\)\.textContent=this\.value;syncEditPinConstraints\('([^']+)'\)$/.exec(action);
  if (labelAndConstraint) {
    const label = document.getElementById(labelAndConstraint[1]);
    if (label) label.textContent = element.value;
    syncEditPinConstraints(labelAndConstraint[2]);
    return;
  }
  const confirmReview = /^if\(confirm\('([^']*)'\)\)reviewAction\(this\.dataset\.bucketId,'delete'\)$/.exec(action);
  if (confirmReview) {
    if (window.confirm(confirmReview[1])) reviewAction(element.dataset.bucketId, 'delete');
    return;
  }

  for (const statement of action.split(';')) {
    const call = /^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/.exec(statement.trim());
    if (!call || !_OB_DYNAMIC_CALLS.has(call[1])) continue;
    const argsText = call[2].trim();
    const args = argsText ? argsText.split(',').map(arg => _obActionArgument(arg, element, event)) : [];
    if (args.some(arg => arg === undefined)) continue;
    const fn = window[call[1]];
    if (typeof fn === 'function') fn(...args);
  }
}

function _obInstallDynamicActionDelegates() {
  for (const eventName of ['click', 'change', 'input', 'submit', 'keydown']) {
    document.addEventListener(eventName, function (event) {
      const element = event.target instanceof Element
        ? event.target.closest('[data-ob-' + eventName + ']')
        : null;
      if (element) _obRunDynamicAction(element, event, element.dataset['ob' + eventName[0].toUpperCase() + eventName.slice(1)] || '');
    });
  }
  for (const eventName of ['mouseenter', 'mouseleave']) {
    document.addEventListener(eventName, function (event) {
      const element = event.target instanceof Element
        ? event.target.closest('[data-ob-' + eventName + ']')
        : null;
      if (element) _obRunDynamicAction(element, event, element.dataset['ob' + eventName[0].toUpperCase() + eventName.slice(1)] || '');
    }, true);
  }
  document.addEventListener('click', function (event) {
    const element = event.target instanceof Element ? event.target.closest('[data-ob-action]') : null;
    if (!element) return;
    if (element.dataset.obAction === 'bucket-page') gotoBucketPage(element.dataset.page);
    if (element.dataset.obAction === 'scroll-field') scrollToField(element.dataset.field);
    if (element.dataset.obAction === 'copy-ob-error') copyOBError(Number(element.dataset.errorIndex));
  });
}

_obInstallDynamicActionDelegates();


// DOM0 handlers externalized from dashboard.html; preserves this/event semantics.
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('anchor-counter').onclick = function (event) {
    document.querySelector('[data-tab=anchors]')?.click()
  };
  document.getElementById('search-input').onkeydown = function (event) {
    if(event.key==='Enter')doSearch()
  };
  document.getElementById('ob-inline-handler-1').onclick = function (event) {
    doSearch()
  };
  document.getElementById('btn-restart').onclick = function (event) {
    restartService()
  };
  document.getElementById('ob-inline-handler-2').onclick = function (event) {
    openFeedback()
  };
  document.getElementById('ob-inline-handler-3').onclick = function (event) {
    doLogout()
  };
  document.getElementById('ob-inline-handler-4').onclick = function (event) {
    gotoEmbedCloud()
  };
  document.getElementById('ob-inline-handler-5').onclick = function (event) {
    gotoEmbedLocal()
  };
  document.getElementById('ob-inline-handler-6').onclick = function (event) {
    toggleStatusBanner()
  };
  document.getElementById('bucket-sort').onchange = function (event) {
    setBucketSort(this.value)
  };
  document.getElementById('bucket-select-all').onchange = function (event) {
    selectAllCurrentPage(this.checked)
  };
  document.getElementById('ob-inline-handler-7').onclick = function (event) {
    runBucketBatch('forget')
  };
  document.getElementById('ob-inline-handler-8').onclick = function (event) {
    runBucketBatch('resolve')
  };
  document.getElementById('ob-inline-handler-9').onclick = function (event) {
    runBucketBatch('archive')
  };
  document.getElementById('ob-inline-handler-10').onclick = function (event) {
    hardDeleteSelectedTests()
  };
  document.getElementById('ob-inline-handler-11').onclick = function (event) {
    event.preventDefault(); bucketsForgetAllow();
  };
  document.getElementById('ob-inline-handler-12').onclick = function (event) {
    runBreathDebug()
  };
  document.getElementById('network-mode').onchange = function (event) {
    loadNetwork()
  };
  document.getElementById('import-preserve-raw-sw').onclick = function (event) {
    syncHwSwitch(this,'import-preserve-raw')
  };
  document.getElementById('ob-inline-handler-13').onclick = function (event) {
    document.getElementById('import-preserve-raw-sw').click()
  };
  document.getElementById('import-preserve-raw').onchange = function (event) {
    syncSwFromCb('import-preserve-raw','import-preserve-raw-sw','')
  };
  document.getElementById('import-start-confirm-btn').onclick = function (event) {
    confirmStartImport()
  };
  document.getElementById('ob-inline-handler-14').onclick = function (event) {
    clearImportPreflight()
  };
  document.getElementById('import-pause-btn').onclick = function (event) {
    pauseImport()
  };
  document.getElementById('ob-inline-handler-15').onclick = function (event) {
    loadImportResults()
  };
  document.getElementById('import-results-more').onclick = function (event) {
    loadMoreImportResults()
  };
  document.getElementById('ob-inline-handler-16').onclick = function (event) {
    detectPatterns()
  };
  document.getElementById('ob-inline-handler-17').onclick = function (event) {
    closeDetail()
  };
  document.getElementById('ob-inline-handler-18').onclick = function (event) {
    loadLogs()
  };
  document.getElementById('ob-inline-handler-19').onclick = function (event) {
    loadOBErrors()
  };
  document.getElementById('ob-inline-handler-20').onclick = function (event) {
    clearOBErrors()
  };
  document.getElementById('ob-inline-handler-21').onclick = function (event) {
    loadV3Debug()
  };
  document.getElementById('ob-inline-handler-22').onclick = function (event) {
    loadPlans()
  };
  document.getElementById('ob-inline-handler-23').onclick = function (event) {
    sendLetter()
  };
  document.getElementById('letter-filter').onchange = function (event) {
    loadLetters()
  };
  document.getElementById('ob-inline-handler-24').onclick = function (event) {
    loadLetters()
  };
  document.getElementById('ob-inline-handler-25').onclick = function (event) {
    loadAnchorsView()
  };
  document.getElementById('ob-inline-handler-26').onclick = function (event) {
    showSettingsGroup('basics')
  };
  document.getElementById('ob-inline-handler-27').onclick = function (event) {
    showSettingsGroup('advanced')
  };
  document.getElementById('ob-inline-handler-28').onclick = function (event) {
    showSettingsGroup('backup')
  };
  document.getElementById('btn-check-ver').onclick = function (event) {
    checkGitHubVersion()
  };
  document.getElementById('btn-export-before-update').onclick = function (event) {
    downloadExport()
  };
  document.getElementById('btn-hot-update').onclick = function (event) {
    doHotUpdate()
  };
  document.getElementById('ob-inline-handler-29').onclick = function (event) {
    saveHumanName()
  };
  document.getElementById('ob-inline-handler-30').onclick = function (event) {
    syncExistingHuman()
  };
  document.getElementById('ob-inline-handler-31').onclick = function (event) {
    changePassword()
  };
  document.getElementById('ob-inline-handler-32').onclick = function (event) {
    regenerateRecoveryCodes()
  };
  document.getElementById('tunnel-toggle-btn').onclick = function (event) {
    toggleTunnel()
  };
  document.getElementById('tunnel-autostart-sw').onclick = function (event) {
    toggleTunnelAutoStart(this)
  };
  document.getElementById('tunnel-autostart').onchange = function (event) {
    syncSwFromCb('tunnel-autostart','tunnel-autostart-sw','tunnel-autostart-led')
  };
  document.getElementById('ob-inline-handler-33').onclick = function (event) {
    saveTunnelToken()
  };
  document.getElementById('ob-inline-handler-34').onclick = function (event) {
    doLogout()
  };
  document.getElementById('ob-inline-handler-35').onclick = function (event) {
    loadSettingsStatus()
  };
  document.getElementById('ob-inline-handler-36').onclick = function (event) {
    loadSystemDiagnostics()
  };
  document.getElementById('ob-inline-handler-37').onclick = function (event) {
    fixPinnedDesync()
  };
  document.getElementById('settings-host-vault-save').onclick = function (event) {
    saveHostVault()
  };
  document.getElementById('ob-inline-handler-38').onclick = function (event) {
    loadHostVault()
  };
  document.getElementById('dehy-preset').onchange = function (event) {
    applyDehyPreset()
  };
  document.getElementById('cfg-dehy-format').onchange = function (event) {
    onDehyFormatChange()
  };
  document.getElementById('ob-inline-handler-39').onclick = function (event) {
    fetchModels('dehy')
  };
  document.getElementById('ob-inline-handler-40').onclick = function (event) {
    saveCompressKey()
  };
  document.getElementById('ob-inline-handler-41').onclick = function (event) {
    testDehydrationKey()
  };
  document.getElementById('emb-preset').onchange = function (event) {
    applyEmbedPreset()
  };
  document.getElementById('ob-inline-handler-42').onclick = function (event) {
    saveEmbedKey()
  };
  document.getElementById('ob-inline-handler-43').onclick = function (event) {
    testEmbeddingKey()
  };
  document.getElementById('cfg-emb-format').onchange = function (event) {
    onEmbFormatChange()
  };
  document.getElementById('ob-inline-handler-44').onclick = function (event) {
    fetchModels('emb')
  };
  document.getElementById('emb-backfill-btn').onclick = function (event) {
    startBackfill()
  };
  document.getElementById('ob-inline-handler-45').onclick = function (event) {
    oneClickLocal()
  };
  document.getElementById('ob-inline-handler-46').onclick = function (event) {
    switchEmbedding('gemini')
  };
  document.getElementById('ob-inline-handler-47').onclick = function (event) {
    loadLocalEmbStatus()
  };
  document.getElementById('ob-inline-handler-48').onclick = function (event) {
    installOllama()
  };
  document.getElementById('ob-inline-handler-49').onclick = function (event) {
    startOllama()
  };
  document.getElementById('ob-inline-handler-50').onclick = function (event) {
    pullLocalModel()
  };
  document.getElementById('ob-inline-handler-51').onclick = function (event) {
    switchEmbedding('ollama')
  };
  document.getElementById('ob-inline-handler-52').onclick = function (event) {
    saveConfig(true)
  };
  document.getElementById('sampling-enabled-sw').onclick = function (event) {
    syncHwSwitch(this,'sampling-enabled')
  };
  document.getElementById('sampling-enabled').onchange = function (event) {
    syncSwFromCb('sampling-enabled','sampling-enabled-sw','sampling-enabled-led')
  };
  document.getElementById('sampling-temp').oninput = function (event) {
    document.getElementById('sampling-temp-val').textContent=this.value;
  };
  document.getElementById('ob-inline-handler-53').onclick = function (event) {
    saveSamplingSettings()
  };
  document.getElementById('ob-inline-handler-54').onclick = function (event) {
    testSamplingBreath()
  };
  document.getElementById('ob-inline-handler-55').onclick = function (event) {
    fetchModels('env-compress')
  };
  document.getElementById('ob-inline-handler-56').onclick = function (event) {
    saveEnvConfig()
  };
  document.getElementById('ob-inline-handler-57').onclick = function (event) {
    loadEnvVars()
  };
  document.getElementById('ob-inline-handler-58').onchange = function (event) {
    onMcpModeChange()
  };
  document.getElementById('ob-inline-handler-59').onchange = function (event) {
    onMcpModeChange()
  };
  document.getElementById('ob-inline-handler-60').onclick = function (event) {
    saveMcpAddress()
  };
  document.getElementById('mcp-custom-domain').oninput = function (event) {
    renderMcpUrls()
  };
  document.getElementById('ob-inline-handler-61').onclick = function (event) {
    copyMcpUrl('main')
  };
  document.getElementById('ob-inline-handler-62').onclick = function (event) {
    switchTransport('streamable-http')
  };
  document.getElementById('ob-inline-handler-63').onclick = function (event) {
    switchTransport('sse')
  };
  document.getElementById('ob-inline-handler-64').onclick = function (event) {
    switchTransport('stdio')
  };
  document.getElementById('cfg-mcp-auth').onchange = function (event) {
    onMcpAuthModeChange()
  };
  document.getElementById('ob-inline-handler-65').onclick = function (event) {
    saveMcpAuth()
  };
  document.getElementById('ob-inline-handler-66').onclick = function (event) {
    regenerateMcpToken()
  };
  document.getElementById('ob-inline-handler-67').onclick = function (event) {
    copyMcpToken()
  };
  document.getElementById('ob-inline-handler-68').onclick = function (event) {
    saveHostPort()
  };
  document.getElementById('ob-inline-handler-69').onclick = function (event) {
    copyAllMcpUrls()
  };
  document.getElementById('ob-inline-handler-70').onclick = function (event) {
    exportClaudeDesktopConfig()
  };
  document.getElementById('developer-mode-sw').onclick = function (event) {
    syncHwSwitch(this,'developer-mode-toggle'); setDeveloperMode(document.getElementById('developer-mode-toggle').checked)
  };
  document.getElementById('ob-inline-handler-71').onclick = function (event) {
    document.getElementById('developer-mode-sw').click()
  };
  document.getElementById('developer-mode-toggle').onchange = function (event) {
    syncSwFromCb('developer-mode-toggle','developer-mode-sw',''); setDeveloperMode(this.checked)
  };
  document.getElementById('ob-inline-handler-72').onclick = function (event) {
    saveGithubConfig()
  };
  document.getElementById('ob-inline-handler-73').onclick = function (event) {
    validateGithub()
  };
  document.getElementById('gh-sync-btn').onclick = function (event) {
    runGithubSync()
  };
  document.getElementById('gh-import-btn').onclick = function (event) {
    runGithubImport()
  };
  document.getElementById('ob-inline-handler-74').onclick = function (event) {
    downloadExport()
  };
  document.getElementById('ob-inline-handler-75').onclick = function (event) {
    loadDuplicates()
  };
  document.getElementById('migrate-upload-zone').onclick = function (event) {
    document.getElementById('migrate-file-input').click()
  };
  document.getElementById('migrate-upload-zone').ondragover = function (event) {
    event.preventDefault();this.style.borderColor='var(--accent)'
  };
  document.getElementById('migrate-upload-zone').ondragleave = function (event) {
    this.style.borderColor='var(--border)'
  };
  document.getElementById('migrate-upload-zone').ondrop = function (event) {
    event.preventDefault();this.style.borderColor='var(--border)';handleMigrateFileDrop(event)
  };
  document.getElementById('migrate-file-input').onchange = function (event) {
    handleMigrateFileSelect(event)
  };
  document.getElementById('migrate-apply-btn').onclick = function (event) {
    applyMigrate()
  };
  document.getElementById('ob-inline-handler-76').onclick = function (event) {
    resetMigrate()
  };
  document.getElementById('ob-inline-handler-77').onclick = function (event) {
    dismissOnboarding()
  };
  document.getElementById('ob-inline-handler-78').onclick = function (event) {
    location.href='/onboarding'
  };
  document.getElementById('auth-setup-pwd2').onkeydown = function (event) {
    if(event.key==='Enter')doSetup()
  };
  document.getElementById('ob-inline-handler-79').onclick = function (event) {
    doSetup()
  };
  document.getElementById('auth-login-pwd').onkeydown = function (event) {
    if(event.key==='Enter')doLogin()
  };
  document.getElementById('ob-inline-handler-80').onclick = function (event) {
    doLogin()
  };
  document.getElementById('ob-inline-handler-81').onclick = function (event) {
    showRecovery();return false;
  };
  document.getElementById('auth-recovery-newpwd').onkeydown = function (event) {
    if(event.key==='Enter')doRecover()
  };
  document.getElementById('ob-inline-handler-82').onclick = function (event) {
    doRecover()
  };
  document.getElementById('ob-inline-handler-83').onclick = function (event) {
    showLogin();return false;
  };
  document.getElementById('feedback-modal').onclick = function (event) {
    if(event.target===this)closeFeedback()
  };
  document.getElementById('ob-inline-handler-84').onclick = function (event) {
    closeFeedback()
  };
  document.getElementById('ob-inline-handler-85').onclick = function (event) {
    closeFeedback()
  };
  document.getElementById('feedback-copy-btn').onclick = function (event) {
    copyFeedback()
  };
  document.getElementById('error-alert-popup').onclick = function (event) {
    if(event.target===this)closeErrorAlertPopup()
  };
  document.getElementById('ob-inline-handler-86').onclick = function (event) {
    closeErrorAlertPopup()
  };
  document.getElementById('ob-inline-handler-87').onclick = function (event) {
    goToLogsTab()
  };
  document.getElementById('ob-inline-handler-88').onclick = function (event) {
    closeErrorAlertPopup()
  };
  document.getElementById('self-overlay').onclick = function (event) {
    closeSelfPanel()
  };
  document.getElementById('ob-inline-handler-89').onclick = function (event) {
    closeSelfPanel()
  };
  document.getElementById('ob-inline-handler-90').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('ob-inline-handler-91').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('ob-inline-handler-92').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('ob-inline-handler-93').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('ob-inline-handler-94').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('ob-inline-handler-95').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('ob-inline-handler-96').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('ob-inline-handler-97').onclick = function (event) {
    setSelfFilter(this)
  };
  document.getElementById('self-fab').onclick = function (event) {
    openSelfPanel()
  };
});
