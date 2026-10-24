const header = document.querySelector('.site-header');
const toggle = document.querySelector('.nav-toggle');
if (header && toggle) {
  toggle.addEventListener('click', () => {
    const open = header.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  header.querySelectorAll('.main-nav a').forEach(a => a.addEventListener('click', () => header.classList.remove('nav-open')));
}

const filterBtns = document.querySelectorAll('[data-filter]');
const cards = document.querySelectorAll('.product-card');
function applyFilter(f) {
  filterBtns.forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  cards.forEach(c => { c.hidden = !(f === 'all' || c.dataset.cat === f); });
}
if (filterBtns.length && cards.length) {
  filterBtns.forEach(btn => btn.addEventListener('click', () => applyFilter(btn.dataset.filter)));
  const initial = new URLSearchParams(location.search).get('cat');
  if (initial && Array.from(filterBtns).some(b => b.dataset.filter === initial)) applyFilter(initial);
}

document.querySelectorAll('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });
