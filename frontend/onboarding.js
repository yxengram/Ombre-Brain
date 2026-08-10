
let selectedProfile = '';
let catalog = [];

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text.trim()) throw new Error('服务没有返回内容（HTTP ' + response.status + '）');
  try { return JSON.parse(text); }
  catch (error) { throw new Error('服务返回了无法识别的内容（HTTP ' + response.status + '）'); }
}

function optionsForSelection() {
  const options = {};
  if (selectedProfile === 'public_secure') options.public_url = document.getElementById('public-url').value.trim();
  if (selectedProfile === 'advanced') {
    options.transport = document.getElementById('transport').value;
    options.mcp_require_auth = document.getElementById('advanced-auth').value === 'true';
    options.public_url = document.getElementById('public-url').value.trim();
  }
  return options;
}

function selectProfile(profile) {
  selectedProfile = profile;
  document.querySelectorAll('.profile').forEach(card => card.classList.toggle('selected', card.dataset.id === profile));
  document.getElementById('advanced-fields').style.display = profile === 'advanced' ? 'block' : 'none';
  document.getElementById('public-fields').style.display = profile === 'local' ? 'none' : 'block';
  const chosen = catalog.find(item => item.id === profile);
  document.getElementById('mode-note').textContent = chosen ? chosen.description : '';
  document.getElementById('save').disabled = false;
  preflight();
}

function renderProfiles(items) {
  catalog = items;
  document.getElementById('profiles').innerHTML = items.map(item =>
    '<article class="profile" data-id="' + item.id + '" data-ob-click="selectProfile%28this.dataset.id%29">' +
    '<h3>' + item.name + '</h3><p>' + item.description + '</p><small>适合：' + item.recommended_for + '</small></article>'
  ).join('');
}

function renderReport(report) {
  const network = report.mcp_network_security || {};
  const lines = [
    '当前模式：' + report.profile,
    '已保存 transport：' + report.saved.transport,
    '当前生效 transport：' + report.effective.transport,
    '已保存 MCP 鉴权：' + (report.saved.mcp_require_auth ? '开启' : '关闭'),
    '当前生效 MCP 鉴权：' + (report.effective.mcp_require_auth ? '开启' : '关闭'),
    '已保存鉴权模式：' + report.saved.mcp_auth_mode,
    '当前生效鉴权模式：' + report.effective.mcp_auth_mode,
    '已保存公网地址：' + (report.saved.public_url || '未设置'),
    '当前生效公网地址：' + (report.effective.public_url || '未设置'),
    '进程监听地址：' + (report.effective.bind_host || '未识别'),
    '容器宿主边界：' + (report.effective.external_bind_address || (network.in_docker ? '未声明' : '不适用')),
    'MCP 网络门禁：' + (network.override_active ? '已显式豁免（高风险）' : '正常（危险配置会拒绝启动）'),
    '记忆目录：' + (report.effective.buckets_dir_configured ? '已配置' : '未配置'),
    '持久性：' + ((report.persistence || {}).persistent ? '已确认' : '需要处理'),
  ];
  if (report.overrides.length) lines.push('平台覆盖：' + report.overrides.map(item => item.env + ' → ' + item.field).join('，'));
  document.getElementById('runtime-report').textContent = lines.join('\n');
}

async function preflight() {
  if (!selectedProfile) return;
  const response = await fetch('/api/onboarding/preflight', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({profile:selectedProfile,options:optionsForSelection()})});
  const data = await readJsonSafe(response);
  const result = document.getElementById('result');
  result.style.display = 'block';
  result.classList.toggle('bad', !data.ok);
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  result.textContent = data.ok
    ? (warnings.length ? '检查通过，但存在高风险豁免：' + warnings.join('；') : '检查通过：保存后重启即可生效。')
    : (data.issues || [data.error]).join('；');
  document.getElementById('save').disabled = !data.ok;
}

async function saveProfile() {
  const button = document.getElementById('save');
  button.disabled = true;
  try {
    const response = await fetch('/api/onboarding/apply', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({profile:selectedProfile,options:optionsForSelection(),confirm:true})});
    const data = await readJsonSafe(response);
    if (!response.ok || !data.ok) throw new Error(data.error || (data.issues || []).join('；'));
    renderReport(data.report);
    const result = document.getElementById('result');
    result.style.display = 'block'; result.classList.remove('bad');
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    result.textContent = data.message
      + (data.report.overrides.length ? ' 注意：平台环境变量仍会覆盖部分设置。' : '')
      + (warnings.length ? ' 高风险豁免：' + warnings.join('；') : '');
    button.textContent = '已保存';
  } catch (error) {
    const result = document.getElementById('result');
    result.style.display = 'block'; result.classList.add('bad'); result.textContent = error.message;
    button.disabled = false;
  }
}

async function boot() {
  try {
    const auth = await fetch('/auth/status', { cache: 'no-store' });
    const authData = await readJsonSafe(auth);
    if (!authData.authenticated) { location.href = '/'; return; }
    const response = await fetch('/api/onboarding/profile');
    const data = await readJsonSafe(response);
    if (!response.ok || !data.ok) throw new Error(data.error || '读取失败');
    renderProfiles(data.profiles); renderReport(data.report);
    if (data.report.profile !== 'unconfigured') selectProfile(data.report.profile);
  } catch (error) {
    document.getElementById('runtime-report').textContent = '加载失败：' + error.message;
  }
}
document.getElementById('public-url').addEventListener('input', preflight);
document.getElementById('transport').addEventListener('change', preflight);
document.getElementById('advanced-auth').addEventListener('change', preflight);
document.addEventListener('click', function (event) {
  const profile = event.target instanceof Element
    ? event.target.closest('[data-ob-click="selectProfile%28this.dataset.id%29"]')
    : null;
  if (profile) selectProfile(profile.dataset.id);
});
boot();

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById('ob-onboarding-handler-1').onclick = function (event) {
    location.href='/'
  };
  document.getElementById('save').onclick = function (event) {
    saveProfile()
  };
});
