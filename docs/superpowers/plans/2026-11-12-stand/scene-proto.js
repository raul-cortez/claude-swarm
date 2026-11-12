const fs = require('fs');
module.exports = async (win, { shot, js, wait }) => {
  await wait(800);
  await js(`localStorage.clear()`);
  await win.loadFile('/Users/evgeniy/WebstormProjects/claude-swarm-lite/renderer/index.html');
  await wait(800);
  const css = fs.readFileSync(__dirname + '/proto.css', 'utf8');
  await win.webContents.insertCSS(css);
  await js(`(async () => {
    for (const id of [...sessions.keys()]) closeSession(id);
    const mk = async (cwd, name) => { await createSession({ cwd, cmd: 'claude', flags: '', name }); return [...sessions.keys()].pop(); };
    const a = await mk('/Users/me/projects/payments-gateway-v2', 'Окно оплаты');
    const b = await mk('/Users/me/projects/payments-gateway-v2', 'Письма о заказе');
    const c = await mk('/Users/me/projects/payments-gateway-v2', 'Экспорт в CSV');
    const d = await mk('/Users/me/projects/marketing-site', 'Тёмная тема');
    const e = await mk('/Users/me/projects/marketing-site', 'Поиск по статьям');
    setStatus(a, 'running', 'работает'); setStatus(b, 'waiting', 'ждёт ответа'); setStatus(c, 'ready', 'готов');
    setStatus(d, 'running', 'работает'); setStatus(e, 'ready', 'готов');
    const own = { [a]: '#f472b6', [c]: '#5b8def', [d]: '#d6b88a' };
    for (const s of sessions.values()) {
      const n = s.tab.querySelector('.label').textContent.split(' ');
      s.tab.dataset.ini = (n[0][0] + (n[1] ? n[1][0] : '')).toUpperCase();
      if (own[s.id]) { s.tab.dataset.own = '1'; s.tab.style.setProperty('--own', own[s.id]); }
    }
    document.querySelectorAll('.group-head').forEach(h => h.dataset.mini = (() => { const parts = h.dataset.cwd.split('/').pop().split(/[-_. ]+/).filter(Boolean); return parts.length > 1 ? parts.slice(0,3).map(x => x[0]).join('') : parts[0].slice(0,3); })());
    activate(c);
  })()`);
  await wait(400);
  const rect = await js(`(() => { const r = document.getElementById('tabs').getBoundingClientRect(); return { x: 0, y: 0, width: Math.round(r.right), height: 560 }; })()`);
  for (const [st, own] of [['bg', 'stripe'], ['border', 'stripe'], ['stripe', 'bg'], ['border', 'bg']]) {
    await js(`document.body.classList.remove('st-bg','st-border','st-stripe','own-bg','own-border','own-stripe'); document.body.classList.add('st-${st}','own-${own}')`);
    await wait(200);
    await shot(`combo-${st}-${own}.png`, rect);
  }
  await js(`document.body.classList.remove('st-bg','st-border','st-stripe','own-bg','own-border','own-stripe'); document.body.classList.add('st-bg','own-stripe','rail-mini');
    const t = document.createElement('div'); t.className='mini-toggle'; t.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>'; document.body.appendChild(t); 0`);
  await wait(300);
  await shot('mini.png', { x: 0, y: 0, width: 600, height: 780 });
};
