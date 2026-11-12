module.exports = async (win, { shot, js, wait }) => {
  await wait(800);
  await js(`localStorage.clear()`);
  await win.loadFile('/Users/evgeniy/WebstormProjects/claude-swarm-lite/renderer/index.html');
  await wait(800);
  await js(`(async () => {
    for (const id of [...sessions.keys()]) closeSession(id);
    const mk = async (cwd, name, o) => { await createSession({ cwd, cmd: 'claude', flags: '', name, ...o }); return [...sessions.keys()].pop(); };
    const p = await mk('/Users/me/projects/payments-gateway', 'Бригада оплаты', { crew: true });
    const a = await mk('/Users/me/projects/payments-gateway', 'Окно оплаты');
    const c = await mk('/Users/me/projects/payments-gateway', 'Экспорт в CSV');
    setStatus(p, 'running', 'работает'); setStatus(a, 'running', 'работает'); setStatus(c, 'ready', 'готов');
    sessions.get(p).digestText = 'Веду переезд оплаты на новый шлюз: два исполнителя делают окно и экспорт, я собираю результат и проверяю тесты.';
    sessions.get(p).term.write('\\x1b[2mClaude Code\\x1b[0m\\r\\n\\r\\n● Исполнитель «Окно оплаты» закончил форму, жду экспорт.\\r\\n● Запускаю тесты платёжного модуля…\\r\\n');
    sessions.get(c).term.write('Экспорт заказов в CSV готов.\\r\\n');
    activate(p);
    window.__p = p; window.__c = c;
  })()`);
  await wait(500);
  const css = `
  #crew-strip { display: none !important; }
  #plan-btn { position: absolute !important; top: 8px; right: 14px; z-index: 5; box-shadow: 0 2px 8px -3px #000; display: inline-flex !important; }
  #digest-strip { padding-right: 120px !important; }
  #strip-actions { flex: none; display: flex; align-items: center; gap: 8px; }
  #digest-strip {  }
  #plan-btn { border: 1px solid var(--border) !important; background: var(--panel-2) !important; padding: 0 9px 0 7px !important; height: 24px !important; border-radius: 999px !important; }
  body.has-crew-strip #digest-strip { padding-right: 16px !important; }
  #stage { flex-direction: row !important; }
  #plan-panel { flex: 0 0 300px; background: var(--panel); border-left: 1px solid var(--hairline); display: flex; flex-direction: column; min-width: 0; }
  #plan-panel[hidden] { display: none; }
  #plan-panel .pp-h { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 12px; font-weight: 600; color: var(--text); border-bottom: 1px solid var(--hairline); }
  #plan-panel .pp-h .pp-n { margin-left: auto; color: var(--muted); font-weight: 500; }
  #plan-panel ul { list-style: none; margin: 0; padding: 8px 10px; font-size: 12.5px; }
  #plan-panel li { display: flex; gap: 8px; padding: 5px 4px; color: var(--text); line-height: 1.35; }
  #plan-panel li.sub { padding-left: 26px; color: var(--muted); font-size: 12px; }
  #plan-panel li.done > span.tx { color: var(--muted); text-decoration: line-through; text-decoration-color: rgba(255,255,255,.25); }
  #plan-panel .bx { flex: none; width: 14px; height: 14px; margin-top: 2px; border: 1.5px solid var(--muted); border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; }
  #plan-panel li.done .bx { background: var(--ready); border-color: var(--ready); color: #0b1a10; }
  #plan-panel li.now .bx { border-color: var(--run); box-shadow: 0 0 0 3px color-mix(in srgb, var(--run) 25%, transparent); }
  #plan-panel li.now { background: color-mix(in srgb, var(--run) 8%, transparent); border-radius: 6px; }
  #plan-panel .pp-f { margin-top: auto; padding: 10px 14px; font-size: 11.5px; color: var(--muted); border-top: 1px solid var(--hairline); }
  #plan-btn { display: inline-flex; align-items: center; gap: 5px; background: transparent; border: 0; color: var(--muted); font-size: 11px; padding: 0 7px; height: 22px; border-radius: 6px; }
  #plan-btn .bd { background: var(--ready); color: #0b1a10; border-radius: 999px; padding: 0 5px; font-weight: 600; font-variant-numeric: tabular-nums; }
  #plan-btn.is-active { color: var(--accent); }
  #plan-btn[disabled] { opacity: .35; }
  #plan-btn svg { width: 14px; height: 14px; }
  .bar-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); padding: 2px 9px 2px 7px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel-2); }
  .bar-chip svg { width: 12px; height: 12px; color: var(--crew); }
  `;
  await win.webContents.insertCSS(css);
  await js(`(() => {
    const stage = document.getElementById('stage');
    const panel = document.createElement('aside'); panel.id = 'plan-panel'; panel.hidden = true;
    panel.innerHTML = '<div class="pp-h"><span>План</span><span class="pp-n">3 из 6</span></div><ul>'
      + '<li class="done"><span class="bx">✓</span><span class="tx">Собрать требования к новому шлюзу</span></li>'
      + '<li class="done"><span class="bx">✓</span><span class="tx">Форма оплаты на новом API</span></li>'
      + '<li class="sub done"><span class="bx">✓</span><span class="tx">Карты и Apple Pay</span></li>'
      + '<li class="done"><span class="bx">✓</span><span class="tx">Экспорт заказов в CSV</span></li>'
      + '<li class="now"><span class="bx"></span><span class="tx">Прогнать тесты платёжного модуля</span></li>'
      + '<li class="sub"><span class="bx"></span><span class="tx">Починить падающий тест возвратов</span></li>'
      + '<li><span class="bx"></span><span class="tx">Обновить документацию</span></li>'
      + '<li><span class="bx"></span><span class="tx">Выкатить на стейдж</span></li></ul>'
      + '<div class="pp-f">Файл работы · обновлено только что</div>';
    stage.appendChild(panel);
    const strip = document.getElementById('digest-strip');
    strip.style.alignItems = 'center'; strip.style.gap = '12px';
    strip.querySelector('.digest-text').style.flex = '1 1 auto';
    const cl = document.createElement('div'); cl.id = 'strip-actions';
    const chip = document.createElement('span'); chip.className = 'bar-chip'; chip.id = 'crew-chip';
    chip.innerHTML = ICONS.crew + 'Прораб бригады';
    const btn = document.createElement('button'); btn.id = 'plan-btn'; btn.title = 'План вкладки';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="m5 7 2 2 3-4" transform="translate(0 -1)"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/><rect width="8" height="4" x="3" y="14" rx="1"/></svg>План<span class="bd">3/6</span>';
    document.getElementById('stage-agents').appendChild(btn);
    window.__show = (open, hasPlan, crew, digest) => {
      panel.hidden = !open; btn.classList.toggle('is-active', open); btn.disabled = !hasPlan;
      btn.style.setProperty('display', hasPlan ? 'inline-flex' : 'none', 'important');
      chip.style.display = crew ? '' : 'none';
      const on = !!digest;
      strip.hidden = !on;
      strip.querySelector('.digest-text').textContent = digest ? sessions.get(activeId).digestText || 'Веду переезд оплаты на новый шлюз: два исполнителя делают окно и экспорт, я собираю результат и проверяю тесты.' : '';
      document.body.classList.toggle('has-digest', on);
      for (const [id, x] of sessions) x.holder.classList.toggle('digested', on && id === activeId);
      if (on) document.documentElement.style.setProperty('--digest-h', strip.offsetHeight + 'px');
      refitActive();
    };
    0;
  })()`);
  const full = { x: 0, y: 0, width: 1200, height: 780 };
  await js(`__show(false, true, false, true)`); await wait(500); await shot('v4-digest.png', full);
  await js(`sessions.get(__p).digestText=''; __show(false, true, false, false)`); await wait(500); await shot('v4-nodigest.png', full);
  await js(`__show(true, true, false, false)`); await wait(500); await shot('v4-open.png', full);
};
