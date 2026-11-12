module.exports = async (win, { shot, js, wait }) => {
  await wait(800);
  await js(`localStorage.clear(); localStorage.setItem('swarm.history', JSON.stringify({h2:{cwd:'/Users/me/projects/shop',name:'Экспорт в CSV',named:false,digest:'Сделал выгрузку заказов в CSV для бухгалтерии, осталось проверить кодировку в Excel.',cmd:'claude',flags:''}}))`);
  await win.loadFile('/Users/evgeniy/WebstormProjects/claude-swarm-lite/renderer/index.html');
  await wait(800);
  await js(`(async () => {
    for (const id of [...sessions.keys()]) closeSession(id);
    await createSession({ cwd: '/Users/me/projects/shop', cmd: 'claude', flags: '', name: 'Окно оплаты' });
    await createSession({ cwd: '/Users/me/projects/shop', cmd: 'claude', flags: '' });
    await createSession({ cwd: '/Users/me/projects/blog', cmd: 'claude', flags: '', name: 'Тёмная тема' });
    const ids=[...sessions.keys()]; setStatus(ids[0], 'running', 'работает'); setStatus(ids[1], 'ready', 'готов'); setStatus(ids[2], 'waiting', 'ждёт ответа');
    setDigestText(ids[1], 'Разбираюсь, почему письма о заказе уходят без номера', 'Письма о заказе');
    activate(ids[0]);
  })()`);
  await wait(500);
  await js(`openHistoryMenu(document.querySelector('.group-hist'), '/Users/me/projects/shop')`);
  await wait(500);
  await shot('history.png');
  console.log(await js(`[...document.querySelectorAll('.tab .label')].map(e=>e.textContent).join(' | ')`));
};
