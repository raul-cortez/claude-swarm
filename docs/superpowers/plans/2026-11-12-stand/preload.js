let n = 0;
const now = Date.now();
const special = {
  platform: 'darwin',
  createSession: async (o) => ({ id: String(++n), cwd: o.cwd || '/Users/me/projects/shop', claudeSessionId: 'cs-' + n }),
  historyScan: async () => [
    { id: 'h1', at: now - 3600e3, prompt: 'в отчёте по продажам даты в американском формате, поправь на наш', title: '' },
    { id: 'h2', at: now - 26 * 3600e3, prompt: 'добавь экспорт заказов в CSV для бухгалтерии', title: '' },
    { id: 'h3', at: now - 9 * 86400e3, prompt: 'почему падает сборка на CI после обновления node?', title: '' },
    { id: 'h4', at: now - 16 * 86400e3, prompt: 'нужен поиск по каталогу с опечатками, посмотри варианты', title: '' },
  ],
};
const mk = (path) => new Proxy(function () {}, {
  get(_t, k) {
    if (k === Symbol.toPrimitive) return () => '';
    if (k === 'then') return undefined;
    if (path === '' && k in special) return special[k];
    return mk(path + '.' + String(k));
  },
  apply() { return Promise.resolve(undefined); },
});
window.swarm = mk('');
