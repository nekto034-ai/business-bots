'use strict';

// Review photos: put files into public/reviews/ and list them here.
const REVIEWS = [
  // { src: 'reviews/company-1.jpg', alt: 'Благодарственное письмо от ООО «…»' },
];

document.getElementById('year').textContent = new Date().getFullYear();

// "Pick two of three" triangle
const chips = [...document.querySelectorAll('input[name="priority"]')];
const note = document.getElementById('triangle-note');
const NOTES = {
  'fast,quality': 'Быстро и качественно — значит, не самое дешёвое.',
  'budget,fast': 'Быстро и недорого — сделаем главное, без излишеств.',
  'budget,quality': 'Качественно и недорого — понадобится чуть больше времени.',
};
function updateTriangle() {
  const picked = chips.filter((c) => c.checked).map((c) => c.value).sort();
  chips.forEach((c) => { c.disabled = !c.checked && picked.length >= 2; });
  note.textContent = NOTES[picked.join(',')] || 'Все три сразу не бывает — так честнее 🙂';
}
chips.forEach((c) => c.addEventListener('change', updateTriangle));

// Reviews + lightbox
const grid = document.getElementById('review-grid');
const lightbox = document.getElementById('lightbox');
if (REVIEWS.length === 0) {
  grid.innerHTML = '<div class="review-placeholder">Здесь будут благодарственные письма</div>'.repeat(2);
} else {
  for (const r of REVIEWS) {
    const btn = document.createElement('button');
    btn.className = 'review';
    btn.innerHTML = `<img src="${r.src}" alt="${r.alt}" loading="lazy">`;
    btn.addEventListener('click', () => {
      lightbox.querySelector('img').src = r.src;
      lightbox.querySelector('img').alt = r.alt;
      lightbox.showModal();
    });
    grid.append(btn);
  }
}
lightbox.addEventListener('click', () => lightbox.close());

// Lead form
const form = document.getElementById('lead-form');
const status = document.getElementById('form-status');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.className = 'form-status';
  const data = new FormData(form);
  const lead = {
    name: data.get('name').trim(),
    contact: data.get('contact').trim(),
    comment: data.get('comment').trim(),
    priorities: data.getAll('priority'),
    website: data.get('website'),
    consent: data.get('consent') === 'on',
  };
  if (!lead.name || !lead.contact) return showError('Заполните имя и контакт.');
  if (!lead.consent) return showError('Нужно согласие на обработку данных.');

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/lead', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lead),
    });
    if (!res.ok) throw new Error();
    form.reset();
    updateTriangle();
    status.className = 'form-status ok';
    status.textContent = 'Спасибо! Заявка отправлена — скоро свяжусь с вами.';
  } catch {
    showError('Не получилось отправить. Попробуйте ещё раз или напишите в Telegram.');
  } finally {
    button.disabled = false;
  }
});
function showError(text) {
  status.className = 'form-status err';
  status.textContent = text;
}
