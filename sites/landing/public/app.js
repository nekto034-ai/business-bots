'use strict';

// Review letters (watermarked, uploaded to the server — see sites/landing/tools/watermark.sh).
const REVIEWS = [
  { src: 'reviews/davinci.jpg', name: 'Клиника «Да Винчи»' },
  { src: 'reviews/shkirpan.jpg', name: 'ИП Шкирпан Д. А.' },
  { src: 'reviews/kirichok.jpg', name: 'ИП Киричок С. В.' },
  { src: 'reviews/chegorsky.jpg', name: 'ИП Чегорский А. С.', note: 'Дом приключений Деда Мороза' },
  { src: 'reviews/ortho.jpg', name: 'ООО «Ортопедические технологии»' },
  { src: 'reviews/shafranskaya.jpg', name: 'ИП Шафранская Н. А.' },
  { src: 'reviews/shcherbakov.jpg', name: 'ИП Щербаков' },
  { src: 'reviews/skazka.jpg', name: 'ООО «Сказка леденцы»' },
];

document.getElementById('year').textContent = new Date().getFullYear();

// ---------- "Pick two of three" triangle ----------
const triangle = document.getElementById('triangle');
const vertices = [...triangle.querySelectorAll('.vertex')];
const edges = [...triangle.querySelectorAll('.edge')];
const note = document.getElementById('triangle-note');
const NOTES = {
  'fast,quality': 'Быстро и качественно — делаем в приоритете, но это не самый бюджетный вариант.',
  'budget,fast': 'Быстро и недорого — запускаем главное, без лишнего.',
  'budget,quality': 'Качественно и недорого — сделаем основательно, понадобится чуть больше времени.',
};
const DEFAULT_NOTE = note.textContent;
let picked = []; // order matters: picking a third drops the oldest

function renderTriangle() {
  const key = [...picked].sort().join(',');
  vertices.forEach((v) => {
    const on = picked.includes(v.dataset.value);
    v.classList.toggle('on', on);
    v.setAttribute('aria-checked', on);
  });
  edges.forEach((e) => e.classList.toggle('on', e.dataset.pair === key));
  triangle.classList.toggle('has-pair', picked.length === 2);
  note.textContent = NOTES[key] || (picked.length === 1 ? 'Отлично. Выберите ещё одну вершину.' : DEFAULT_NOTE);
  note.classList.toggle('done', picked.length === 2);
}
function toggleVertex(value) {
  if (picked.includes(value)) picked = picked.filter((p) => p !== value);
  else picked = [...picked, value].slice(-2);
  renderTriangle();
}
vertices.forEach((v) => {
  v.addEventListener('click', () => toggleVertex(v.dataset.value));
  v.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVertex(v.dataset.value); }
  });
});

// ---------- Reviews carousel ----------
const carousel = document.getElementById('carousel');
const dotsBox = document.getElementById('dots');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');

REVIEWS.forEach((r, i) => {
  const card = document.createElement('button');
  card.className = 'review';
  card.innerHTML = `<img src="${r.src}" alt="Благодарственное письмо: ${r.name}" loading="lazy" draggable="false">`
    + `<span class="review-caption"><b>${r.name}</b>${r.note ? `<small>${r.note}</small>` : ''}</span>`;
  card.addEventListener('click', () => openLightbox(i));
  carousel.append(card);

  const dot = document.createElement('button');
  dot.setAttribute('aria-label', `Письмо ${i + 1}`);
  dot.addEventListener('click', () => scrollToCard(i));
  dotsBox.append(dot);
});
const cards = [...carousel.children];
const dots = [...dotsBox.children];

function cardStep() {
  return cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : carousel.clientWidth;
}
function scrollToCard(i) { carousel.scrollTo({ left: cards[i].offsetLeft - cards[0].offsetLeft }); }
function updateCarousel() {
  const max = carousel.scrollWidth - carousel.clientWidth;
  prevBtn.disabled = carousel.scrollLeft <= 2;
  nextBtn.disabled = carousel.scrollLeft >= max - 2;
  const active = Math.round(carousel.scrollLeft / cardStep());
  dots.forEach((d, i) => d.classList.toggle('on', i === active));
}
prevBtn.addEventListener('click', () => carousel.scrollBy({ left: -cardStep() }));
nextBtn.addEventListener('click', () => carousel.scrollBy({ left: cardStep() }));
carousel.addEventListener('scroll', () => requestAnimationFrame(updateCarousel), { passive: true });
carousel.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') nextBtn.click();
  if (e.key === 'ArrowLeft') prevBtn.click();
});
window.addEventListener('resize', updateCarousel);
updateCarousel();

// ---------- Lightbox ----------
const lightbox = document.getElementById('lightbox');
const lbImg = lightbox.querySelector('img');
const lbCaption = lightbox.querySelector('figcaption');
let lbIndex = 0;
function showLightbox(i) {
  lbIndex = (i + REVIEWS.length) % REVIEWS.length;
  const r = REVIEWS[lbIndex];
  lbImg.src = r.src;
  lbImg.alt = `Благодарственное письмо: ${r.name}`;
  lbCaption.textContent = r.name;
}
function openLightbox(i) { showLightbox(i); lightbox.showModal(); }
lightbox.querySelector('.lb-close').addEventListener('click', () => lightbox.close());
lightbox.querySelector('.lb-prev').addEventListener('click', (e) => { e.stopPropagation(); showLightbox(lbIndex - 1); });
lightbox.querySelector('.lb-next').addEventListener('click', (e) => { e.stopPropagation(); showLightbox(lbIndex + 1); });
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });
lightbox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') showLightbox(lbIndex + 1);
  if (e.key === 'ArrowLeft') showLightbox(lbIndex - 1);
});

// Light deterrent against saving the letters (the burned-in watermark is the real protection).
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.review, .lightbox')) e.preventDefault();
});

// ---------- Lead form ----------
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
    priorities: picked,
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
    picked = [];
    renderTriangle();
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
