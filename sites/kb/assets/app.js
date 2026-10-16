/* Поведение страниц базы знаний: модули потерь (фильтры, поиск, акценты) и возражения. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const PRICE_LINK = k => k === 'dev' ? 'soprovozhdenie.html#s-dev' : 'ceny.html#p-' + k;
  const talkHtml = arr => arr.map((t, i) =>
    `<div class="line" data-acc="${ACC[i]}"><span class="acc a-${ACC[i]}">${ACCN[ACC[i]]}</span><span>${t}</span></div>`).join('');

  function modHtml(x) {
    const links = x.pr.map(k => `<a href="${PRICE_LINK(k)}">${PR[k]}</a>`).join('');
    return `<article class="mod" id="m${x.c}" data-stage="${x.st}" data-text="${(x.n + ' ' + x.say + ' ' + x.fix + ' ' + x.hit).toLowerCase()}">
      <div class="mod-h"><span class="code">М${x.c}</span><h3>${x.n}</h3><span class="chip coral">бьёт по: ${x.hit}</span></div>
      <p class="say">${x.say}</p>
      <div class="kv">
        <div><span class="k">Вопрос клиенту</span><span>${x.q}</span></div>
        <div><span class="k">Метрика «было → стало»</span><span>${x.m}</span></div>
        <div><span class="k">Что настраиваем</span><span>${x.fix}</span></div>
      </div>
      <div class="talk">${talkHtml(x.t)}</div>
      <div class="links"><span class="faint">В прайсе:</span>${links}</div>
    </article>`;
  }

  function applyAccent(a) {
    document.querySelectorAll('[data-acc-btn]').forEach(b => b.setAttribute('aria-pressed', b.dataset.accBtn === a ? 'true' : 'false'));
    document.querySelectorAll('.talk .line').forEach(l => { l.hidden = !(a === 'all' || l.dataset.acc === a); });
    store.set('kb-acc', a);
  }

  // ---- модули ----
  const list = $('#modlist');
  if (list) {
    list.innerHTML = STAGES.map((s, i) => {
      const items = M.filter(x => x.st === i);
      return `<div class="stage" data-stage-block="${i}"><div class="stage-h"><b>${s}</b><span>этап ${i + 1} · ${items.length} мод.</span></div><div class="mods">${items.map(modHtml).join('')}</div></div>`;
    }).join('');
    let stage = 'all';
    const q = $('#q');
    const empty = $('#empty');
    function filter() {
      const text = (q.value || '').trim().toLowerCase();
      let shown = 0;
      document.querySelectorAll('.mod').forEach(m => {
        const ok = (stage === 'all' || m.dataset.stage === stage) && (!text || m.dataset.text.includes(text));
        m.hidden = !ok; if (ok) shown++;
      });
      document.querySelectorAll('[data-stage-block]').forEach(b => {
        b.hidden = !b.querySelector('.mod:not([hidden])');
      });
      empty.hidden = shown > 0;
    }
    document.querySelectorAll('[data-stage-btn]').forEach(b => b.addEventListener('click', () => {
      stage = b.dataset.stageBtn;
      document.querySelectorAll('[data-stage-btn]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      filter();
    }));
    q.addEventListener('input', filter);
    filter();
  }

  // ---- возражения ----
  const obj = $('#objlist');
  if (obj) {
    obj.innerHTML = OBJ.map(o => `<article class="mod" id="${o.id}">
      <div class="mod-h"><h3>«${o.q}»</h3></div>
      <p class="soft"><b style="color:var(--ink)">Сначала уточнить:</b> ${o.clarify}</p>
      <div class="talk">${talkHtml(o.a)}</div></article>`).join('');
  }

  if (document.querySelector('[data-acc-btn]')) {
    document.querySelectorAll('[data-acc-btn]').forEach(b => b.addEventListener('click', () => applyAccent(b.dataset.accBtn)));
    applyAccent(store.get('kb-acc', 'all'));
  }

  if (location.hash) { const el = document.getElementById(location.hash.slice(1)); if (el) setTimeout(() => el.scrollIntoView(), 50); }
})();
