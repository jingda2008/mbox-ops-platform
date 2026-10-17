import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pages from '../data/pages.json' with {type:'json'};

const labels = {
  zh: ['联系电话', '联系邮箱'],
  en: ['Phone', 'Email'],
  ru: ['Телефон', 'Эл. почта'],
  ja: ['電話', 'メール'],
  ko: ['전화', '이메일'],
  fr: ['Téléphone', 'E-mail'],
  de: ['Telefon', 'E-Mail'],
};
const langs = Object.keys(labels);
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

function line(label) {
  return `<p class="contact-email-line"><span class="email-label">${label}</span><a class="contact-email" href="mailto:shmbox@qq.com">shmbox@qq.com</a></p>`;
}
function phoneLine(label, {arrow = true, phoneClass = ''} = {}) {
  const cls = phoneClass ? ` class="${phoneClass}"` : '';
  const mark = arrow ? ' ↗' : '';
  return `<p class="contact-phone-line"><span class="phone-label">${label}</span><a${cls} href="tel:+8617621392152">+86 176 2139 2152${mark}</a></p>`;
}
function pair(tel, email, options) {
  return `<div class="contact-pair">${phoneLine(tel, options)}${line(email)}</div>`;
}

test('labeled contact email sits directly under each displayed phone number', () => {
  for (const lang of langs) {
    const [telLabel, emailLabel] = labels[lang];
    const email = line(emailLabel);
    const linked = pair(telLabel, emailLabel, {arrow: true});
    const visit = pair(telLabel, emailLabel, {arrow: false, phoneClass: 'phone'});
    const home = pages['/' + lang + '/'];
    assert.equal(home.split(email).length - 1, 4, lang + ' home');
    assert.ok(home.includes('<div class="hero-contact">' + email + '</div><div class="hero-actions">'), lang + ' prominent email');
    assert.equal(home.split(linked).length - 1, 2, lang + ' home linked pairs');
    assert.equal(home.split(visit).length - 1, 1, lang + ' visit pair');
    assert.ok(home.includes('<div class="footer-contact">' + linked), lang + ' footer');
    assert.equal(pages['/' + lang + '/menu/'].split(linked).length - 1, 1, lang + ' menu');
    assert.match(home, new RegExp('class="button gold event-link" href="tel:\\+8617621392152">[\\s\\S]*?</a>' + linked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const file of [`public/${lang}/reserve/index.html`, `aliyun/public-overrides/${lang}/reserve/index.html`]) {
      const html = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
      assert.equal(html.split(linked).length - 1, 2, file);
      assert.equal(html.includes('class="text-link" href="tel:+8617621392152"'), false, file);
    }
  }
});

test('every shown venue email carries its localized prefix', () => {
  const anchor = '<a class="contact-email" href="mailto:shmbox@qq.com">shmbox@qq.com</a>';
  for (const lang of langs) {
    const email = line(labels[lang][1]);
    const files = [
      pages['/' + lang + '/'],
      pages['/' + lang + '/menu/'],
      fs.readFileSync(new URL(`../public/${lang}/reserve/index.html`, import.meta.url), 'utf8'),
      fs.readFileSync(new URL(`../aliyun/public-overrides/${lang}/reserve/index.html`, import.meta.url), 'utf8'),
    ];
    for (const html of files) {
      const shown = html.split(anchor).length - 1;
      assert.ok(shown > 0);
      assert.equal(html.split(email).length - 1, shown);
      assert.equal(html.split('shmbox@qq.com').length - 1, shown * 2);
    }
  }
});

test('phone and email lines share one aligned pair', () => {
  assert.ok(css.includes('.contact-pair{display:grid;grid-template-columns:max-content max-content'));
  assert.ok(css.includes('.contact-phone-line,.contact-email-line{display:contents}'));
  assert.ok(css.includes('.contact-card .contact-pair p,.contact-card .contact-pair .phone-label,.contact-card .contact-pair .email-label,.contact-card .contact-pair a{font:clamp(20px,2.2vw,32px)/1.3 var(--sans)'));
  assert.ok(css.includes('.contact-card .contact-pair p,.contact-card .contact-pair .phone-label,.contact-card .contact-pair .email-label,.contact-card .contact-pair a{font-size:22px}'));
  assert.ok(css.includes('.footer-contact .contact-pair{row-gap:8px;justify-self:end}'));
  assert.ok(css.includes('.footer-contact .contact-pair{justify-self:start}'));
});
