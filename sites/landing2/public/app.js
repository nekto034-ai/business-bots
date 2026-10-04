'use strict';

// Review letters are shared with site 1 (served from the server's reviews dir).
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

// ---------- Loss calculator ----------
const calcForm = document.getElementById('calc-form');
const rub = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
function updateCalc() {
  const v = (name) => Math.max(0, Number(calcForm.elements[name].value) || 0);
  const lostLeads = v('leads') * Math.min(v('lost'), 100) / 100;
  const perMonth = lostLeads * Math.min(v('conv'), 100) / 100 * v('check');
  document.getElementById('calc-month').textContent = `${rub(perMonth)} в месяц`;
  document.getElementById('calc-year').textContent = `≈ ${rub(perMonth * 12)} в год · ${Math.round(lostLeads)} потерянных заявок в месяц`;
}
calcForm.addEventListener('input', updateCalc);
calcForm.addEventListener('submit', (e) => e.preventDefault());
updateCalc();

// ---------- Priorities: pick two of three ----------
const chips = [...document.querySelectorAll('.chip')];
let picked = [];
function renderChips() { chips.forEach((c) => c.classList.toggle('on', picked.includes(c.dataset.value))); }
chips.forEach((c) => c.addEventListener('click', () => {
  const v = c.dataset.value;
  picked = picked.includes(v) ? picked.filter((p) => p !== v) : [...picked, v].slice(-2);
  renderChips();
}));

// ---------- Reviews carousel ----------
const carousel = document.getElementById('carousel');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
REVIEWS.forEach((r, i) => {
  const card = document.createElement('button');
  card.className = 'review';
  card.innerHTML = `<img src="${r.src}" alt="Благодарственное письмо: ${r.name}" loading="lazy" draggable="false">`
    + `<span class="review-caption"><b>${r.name}</b>${r.note ? `<small>${r.note}</small>` : ''}</span>`;
  card.addEventListener('click', () => openLightbox(i));
  carousel.append(card);
});
const cards = [...carousel.children];
const cardStep = () => (cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : carousel.clientWidth);
function updateCarousel() {
  prevBtn.disabled = carousel.scrollLeft <= 2;
  nextBtn.disabled = carousel.scrollLeft >= carousel.scrollWidth - carousel.clientWidth - 2;
}
prevBtn.addEventListener('click', () => carousel.scrollBy({ left: -cardStep() }));
nextBtn.addEventListener('click', () => carousel.scrollBy({ left: cardStep() }));
carousel.addEventListener('scroll', () => requestAnimationFrame(updateCarousel), { passive: true });
window.addEventListener('resize', updateCarousel);
updateCarousel();

// ---------- Lightbox ----------
const lightbox = document.getElementById('lightbox');
const lbImg = lightbox.querySelector('img');
const lbCaption = lightbox.querySelector('figcaption');
let lbIndex = 0;
function showLightbox(i) {
  lbIndex = (i + REVIEWS.length) % REVIEWS.length;
  lbImg.src = REVIEWS[lbIndex].src;
  lbImg.alt = `Благодарственное письмо: ${REVIEWS[lbIndex].name}`;
  lbCaption.textContent = REVIEWS[lbIndex].name;
}
function openLightbox(i) { showLightbox(i); lightbox.showModal(); }
lightbox.querySelector('.lb-close').addEventListener('click', () => lightbox.close());
lightbox.querySelector('.lb-prev').addEventListener('click', () => showLightbox(lbIndex - 1));
lightbox.querySelector('.lb-next').addEventListener('click', () => showLightbox(lbIndex + 1));
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });
lightbox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') showLightbox(lbIndex + 1);
  if (e.key === 'ArrowLeft') showLightbox(lbIndex - 1);
});
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.review, .lightbox')) e.preventDefault(); });

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
    const res = await fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lead) });
    if (!res.ok) throw new Error();
    form.reset();
    picked = [];
    renderChips();
    status.className = 'form-status ok';
    status.textContent = 'Спасибо! Заявка отправлена — скоро свяжусь с вами.';
  } catch {
    showError('Не получилось отправить. Попробуйте ещё раз или напишите в Telegram.');
  } finally {
    button.disabled = false;
  }
});
function showError(text) { status.className = 'form-status err'; status.textContent = text; }
