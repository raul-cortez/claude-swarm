'use strict';
// pty-raw-write.js — доставка одного куска байт в fd мимо node-pty.
// Разбор: BUG-pty-deadlock-2026-08-11.md, docs/superpowers/specs/2026-08-27-pty-raw-write-design.md.
//
// node-pty пишет через net.Socket/uv_write2, и при частичной записи (обычное дело для pty,
// когда читатель на другом конце не поспевает) libuv сам, на C++-уровне, доедает остаток
// тугим ретраем — не отдавая такт циклу событий. 11 и 27 августа это вешало главный поток
// намертво со 100% CPU. Здесь то же самое, но руками: каждый вызов writeSyncFn берёт
// сколько ядро приняло за раз, а недописанный хвост уходит на следующий такт через
// schedule() — а не доедается тем же вызовом.

function writeAll(writeSyncFn, fd, buffer, schedule) {
  return new Promise((resolve) => {
    const total = buffer.length;
    let offset = 0;
    function step() {
      if (offset >= total) { resolve({ ok: true }); return; }
      let n;
      try {
        n = writeSyncFn(fd, buffer, offset, total - offset);
      } catch (err) {
        if (err && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK')) { schedule(step); return; }
        resolve({ ok: false, err });
        return;
      }
      offset += n;
      if (offset >= total) { resolve({ ok: true }); return; }
      schedule(step);
    }
    step();
  });
}

module.exports = { writeAll };
