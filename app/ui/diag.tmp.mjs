import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const filter = { rowType:'principal', orientation:'rows-as-resources', subject:{include:[],exclude:[]}, resource:{include:[],exclude:[]} };
await p.goto('http://localhost:5173/#matrix?filter=' + encodeURIComponent(JSON.stringify(filter)));
await p.waitForLoadState('networkidle');
await p.locator('table').first().waitFor({ timeout: 40000 });
await p.waitForTimeout(2000);
const out = await p.evaluate(() => {
  const de = document.documentElement;
  const grid = [...document.querySelectorAll('div')].find(el => {
    const s = getComputedStyle(el);
    return /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
  });
  const r = grid.getBoundingClientRect();
  const footer = document.querySelector('footer');
  const chain = [];
  let el = grid;
  while (el && el !== de) {
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    chain.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,80), top: Math.round(b.top+scrollY), h: Math.round(b.height), pt: s.paddingTop, pb: s.paddingBottom, mt: s.marginTop, mb: s.marginBottom, gap: s.gap, disp: s.display, ovY: s.overflowY });
    el = el.parentElement;
  }
  return {
    pageOverflow: de.scrollHeight - de.clientHeight,
    clientH: de.clientHeight, scrollH: de.scrollHeight, bodyScrollH: document.body.scrollHeight,
    gridTop: Math.round(r.top + scrollY), gridH: Math.round(r.height), gridMaxH: grid.style.maxHeight,
    gridBottom: Math.round(r.bottom + scrollY),
    footerH: footer ? Math.round(footer.getBoundingClientRect().height) : null,
    footerTop: footer ? Math.round(footer.getBoundingClientRect().top+scrollY) : null,
    footerBottom: footer ? Math.round(footer.getBoundingClientRect().bottom+scrollY) : null,
    footerMB: footer ? getComputedStyle(footer).marginBottom : null,
    chain,
  };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
