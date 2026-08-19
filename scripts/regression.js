// Regression smoke test -- run this against a fresh local server before every push
// from here on. Covers every flow verified individually earlier in development so a
// new change can't silently break something that used to work. Exits non-zero on any
// failure so it can gate a push.
//
// Usage: rm -f pinktt.db*; node server.js & then:
//   NODE_PATH=/opt/node22/lib/node_modules node scripts/regression.js
//
// Set PW_CHROMIUM_PATH to pin a specific browser binary (used in some sandboxes with a
// pre-installed Chromium). Left unset -- e.g. in CI, after `playwright install chromium`
// -- Playwright resolves its own installed browser.

const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

async function main() {
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
  );

  // 1. Syntax sanity (belt-and-suspenders; the caller should already have run node -c)
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.waitForTimeout(800);
    record('landing page loads with no JS exceptions', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // 2. Login for all four demo roles
  for (const [label, email, pass] of [
    ['admin', 'admin@pink.tt', 'Admin@PinkTT2024'],
    ['rider', 'sarah@demo.pink.tt', 'Rider@2024'],
    ['driver (approved)', 'aminah@demo.pink.tt', 'Driver@2024'],
    ['driver (pending)', 'priya@demo.pink.tt', 'Driver@2024'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.evaluate(() => localStorage.setItem('ptt_onboarded', '1'));
    await page.evaluate(() => go('login'));
    await page.fill('#l-email', email);
    await page.fill('#l-pass', pass);
    await page.click('#l-btn');
    await page.waitForTimeout(1200);
    const activePage = await page.evaluate(() => document.querySelector('.page.active')?.id);
    record(`login: ${label}`, !!activePage && activePage !== 'pg-login' && errors.length === 0,
      `landed on ${activePage}` + (errors.length ? ' errors: ' + errors.join(' | ') : ''));
    await page.close();
  }

  // 3. Rider flow: book ride, tabs, no horizontal overflow at 320px
  {
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.evaluate(() => localStorage.setItem('ptt_onboarded', '1'));
    await page.evaluate(() => go('login'));
    await page.fill('#l-email', 'sarah@demo.pink.tt');
    await page.fill('#l-pass', 'Rider@2024');
    await page.click('#l-btn');
    await page.waitForTimeout(1200);

    const overflowBook = await page.evaluate(() => {
      const b = document.getElementById('rider-body');
      const t = document.querySelector('.tabs');
      return { bodyOK: b.scrollWidth <= b.clientWidth + 1, tabsOK: t.scrollWidth <= t.clientWidth + 1 };
    });
    record('rider: no horizontal overflow at 320px (Book Ride)', overflowBook.bodyOK && overflowBook.tabsOK, JSON.stringify(overflowBook));

    for (const tab of ['hist', 'pay', 'promo']) {
      await page.evaluate(t => rTab(t), tab);
      await page.waitForTimeout(400);
      const ok = await page.evaluate(() => {
        const b = document.getElementById('rider-body');
        return b.scrollWidth <= b.clientWidth + 1;
      });
      record(`rider: ${tab} tab renders, no overflow`, ok);
    }
    record('rider: no page exceptions across tabs', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // 4. Backdrop: same video file, correct dims, playing, on a non-landing page
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(BASE + '/');
    await page.evaluate(() => localStorage.setItem('ptt_onboarded', '1'));
    await page.evaluate(() => go('login'));
    await page.fill('#l-email', 'sarah@demo.pink.tt');
    await page.fill('#l-pass', 'Rider@2024');
    await page.click('#l-btn');
    await page.waitForTimeout(1500);
    const v = await page.evaluate(() => {
      const el = document.getElementById('app-bg-video');
      return { readyState: el.readyState, w: el.videoWidth, h: el.videoHeight, paused: el.paused };
    });
    // Assert behaviour (decoded, has real dimensions, actually playing) rather than a
    // specific resolution -- pinning 1280x720 here meant swapping the clip failed the
    // suite even though the backdrop was working perfectly.
    record('backdrop video loads and plays on rider page', v.readyState === 4 && v.w > 0 && v.h > 0 && !v.paused, JSON.stringify(v));
    await page.close();
  }

  // 5. Onboarding carousel: full walkthrough for a fresh (non-onboarded) visitor
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/'); // deliberately no localStorage flag set
    await page.waitForTimeout(500);
    await page.evaluate(()=>document.getElementById('install-banner')?.remove()); await page.click('.topbar button:has-text("Sign Up")');
    await page.waitForTimeout(500);
    const onOnboard = await page.evaluate(() => document.querySelector('.page.active')?.id === 'pg-onboard');
    record('onboarding: first-time Sign Up shows carousel', onOnboard);
    // Derive the advance count from the actual slide count -- hardcoding it meant adding
    // a slide silently broke this test rather than testing the new reality.
    const slideCount = await page.evaluate(() => document.querySelectorAll('#onb-slides .onb-slide').length);
    for (let i = 0; i < slideCount - 1; i++) { await page.click('#onb-next'); await page.waitForTimeout(300); }
    const lastLabel = await page.textContent('#onb-next');
    record('onboarding: last slide shows Get Started', lastLabel.trim() === 'Get Started', lastLabel);
    await page.click('#onb-next');
    await page.waitForTimeout(500);
    const landedRegister = await page.evaluate(() => document.querySelector('.page.active')?.id === 'pg-register');
    record('onboarding: finishing lands on register', landedRegister);
    // returning visit should skip it
    await page.evaluate(() => go('land'));
    await page.evaluate(()=>document.getElementById('install-banner')?.remove());
    await page.click('.topbar button:has-text("Sign Up")');
    await page.waitForTimeout(400);
    const skippedSecondTime = await page.evaluate(() => document.querySelector('.page.active')?.id === 'pg-register');
    record('onboarding: returning visitor skips carousel', skippedSecondTime);
    record('onboarding: no page exceptions', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // 5b. Payload scoping. This is a security check, not a UI one: /api/db used to return
  // the entire platform to every authenticated user. Asserted here so the leak cannot
  // quietly come back the next time buildDB gains a table.
  {
    const api = async (path, opts) => (await fetch('http://localhost:3000' + path, opts)).json();
    const login = async (email, password) => (await api('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }) })).token;
    const dbFor = async t => (await api('/api/db', { headers: { Authorization: 'Bearer ' + t } })).db;

    const riderTok = await login('sarah@demo.pink.tt', 'Rider@2024');
    const adminTok = await login('admin@pink.tt', 'Admin@PinkTT2024');
    const rd = await dbFor(riderTok), ad = await dbFor(adminTok);

    const foreignEmails = rd.users.filter(u => u.email && u.email !== 'sarah@demo.pink.tt').length;
    const foreignEC = rd.users.filter(u => u.emergency_contact_phone && u.email !== 'sarah@demo.pink.tt').length;
    const licences = rd.driver_profiles.filter(d => d.license_number).length;
    record('privacy: rider gets no other users\' emails', foreignEmails === 0, 'found ' + foreignEmails);
    record('privacy: rider gets no other emergency contacts', foreignEC === 0, 'found ' + foreignEC);
    record('privacy: rider gets no driver licence numbers', licences === 0, 'found ' + licences);
    record('privacy: rider keeps own full record', !!rd.users.find(u => u.email === 'sarah@demo.pink.tt'));
    record('privacy: admin still sees full data', ad.users.filter(u => u.email).length > 0 && ad.driver_profiles.filter(d => d.license_number).length > 0);
    record('app still works: driver profiles present for rider UI', rd.driver_profiles.length > 0, 'count=' + rd.driver_profiles.length);
  }

  // 6. Admin dashboard loads
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.evaluate(() => localStorage.setItem('ptt_onboarded', '1'));
    await page.evaluate(() => go('login'));
    await page.fill('#l-email', 'admin@pink.tt');
    await page.fill('#l-pass', 'Admin@PinkTT2024');
    await page.click('#l-btn');
    await page.waitForTimeout(1200);
    const onAdmin = await page.evaluate(() => document.querySelector('.page.active')?.id === 'pg-admin');
    record('admin dashboard loads after login', onAdmin && errors.length === 0, errors.join(' | '));
    await page.close();
  }

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(50));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach(f => console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('Regression script crashed:', e); process.exit(1); });
