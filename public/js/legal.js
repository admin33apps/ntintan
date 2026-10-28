// Legal pages: honour saved theme, print button, current year. No tracking.
try {
  const t = JSON.parse(localStorage.getItem('ntn_theme'));
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
} catch { /* storage unavailable */ }
document.getElementById('printBtn')?.addEventListener('click', () => window.print());
const y = document.getElementById('year');
if (y) y.textContent = String(new Date().getFullYear());
