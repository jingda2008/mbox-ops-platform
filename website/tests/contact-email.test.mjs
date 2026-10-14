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
function phoneLine(label) {
  return `<p class="contact-phone-line"><span class="phone-label">${label}</span><a href="tel:+8617621392152">+86 176 2139 2152 ↗</a></p>`;
}

test('labeled contact email sits directly under each displayed phone number', () => {
  for (const lang of langs) {
    const [telLabel, emailLabel] = labels[lang];
    const email = line(emailLabel);
    const phone = phoneLine(telLabel);
    const home = pages['/' + lang + '/'];
    assert.equal(home.split(email).length - 1, 3, lang + ' home');
    assert.ok(home.includes('<div class="footer-contact">' + phone + email), lang + ' footer');
    assert.equal(home.split(phone).length - 1, 1, lang + ' footer phone');
    assert.equal(pages['/' + lang + '/menu/'].split(phone).length - 1, 1, lang + ' menu phone');
    assert.ok(home.includes('<a class="phone" href="tel:+8617621392152">+86 176 2139 2152</a>' + email), lang + ' visit');
    assert.match(home, new RegExp('class="button gold event-link" href="tel:\\+8617621392152">[\\s\\S]*?</a>' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(pages['/' + lang + '/menu/'].split(email).length - 1, 1, lang + ' menu');
    assert.equal(home.includes('<a class="contact-email"'), true);
    assert.equal(home.includes('>shmbox@qq.com</a></p>'), true);
    for (const file of [`public/${lang}/reserve/index.html`, `aliyun/public-overrides/${lang}/reserve/index.html`]) {
      const html = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
      assert.equal(html.split(email).length - 1, 2, file);
      assert.equal(html.split(phone).length - 1, 1, file + ' footer phone');
      assert.match(html, /class="text-link" href="tel:\+8617621392152">[^<]*\+86 176 2139 2152 ↗<\/a><p class="contact-email-line">/);
    }
  }
});

test('contact card email uses the same type size as the phone number', () => {
  assert.ok(css.includes('.contact-card .phone{display:block;font:clamp(20px,2.5vw,35px)/1.3 var(--serif)'));
  assert.ok(css.includes('.contact-card .contact-email-line{font:clamp(20px,2.5vw,35px)/1.3 var(--sans);font-weight:400'));
  assert.ok(css.includes('.contact-card .phone{font-size:27px}'));
  assert.ok(css.includes('.contact-card .contact-email-line{font-size:27px}'));
  assert.ok(css.includes('.footer-contact{display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-size:14px}'));
  assert.ok(css.includes('.footer-contact .contact-phone-line,.footer-contact .contact-email-line{font-family:var(--sans);font-size:14px'));
  assert.ok(css.includes('.booking-panel .contact-email-line,.events .contact-email-line{font-size:14px'));
});
