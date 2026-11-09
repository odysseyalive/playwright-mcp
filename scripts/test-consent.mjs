#!/usr/bin/env node
// T1 acceptance — cookie-consent dismissal patterns (deterministic, no browser).
// Exercises the pure parts of src/consent.ts (dist/). Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACCEPT_TEXT, ACCEPT_SELECTORS, CONSENT_MARKUP } from '../dist/consent.js';

test('ACCEPT_TEXT: accept-all wording matches in every supported language', () => {
  for (const label of [
    'Accept all',
    ' Accetta tutti',
    'Accetta',
    'Alle akzeptieren',
    'Alle zulassen',
    'Tout accepter',
    "J'accepte",
    'J’accepte',
    'Aceptar todas',
    'Aceptar',
    'Alles accepteren',
    'Aceitar todos',
  ]) {
    assert.match(label, ACCEPT_TEXT, label);
  }
});

test('ACCEPT_TEXT: reject and continue-without wording never matches', () => {
  for (const label of [
    'Rifiuta',
    'Rifiuta tutti',
    'Continua senza consenso',
    'Alle ablehnen',
    'Tout refuser',
    'Continuer sans accepter',
    'Rechazar',
    'Alles weigeren',
    'Rejeitar',
    'Preferenze sulla privacy individuali',
    'Accetta solo i necessari',
  ]) {
    assert.doesNotMatch(label, ACCEPT_TEXT, label);
  }
});

test('CONSENT_MARKUP: recognises the atergolupi Real Cookie Banner and the WordPress/SaaS vendors', () => {
  // atergolupi.com, 2026-11-08: the banner root as served (id is per request).
  assert.match(
    '<div id="a7d139b4b-903f-4b76-bae7-5572410c6223" consent-skip-blocker="1" class="" data-bg="background-color: rgba(0, 0, 0, 0.380);">',
    CONSENT_MARKUP,
  );
  assert.match('<link href="/wp-content/plugins/real-cookie-banner/public/x.css">', CONSENT_MARKUP);
  assert.match('<div id="cmplz-cookiebanner-container">', CONSENT_MARKUP);
  assert.match('<button class="iubenda-cs-accept-btn">', CONSENT_MARKUP);
  assert.match('<div class="cky-consent-container">', CONSENT_MARKUP);
  assert.match('<p>Utilizziamo cookie e tecnologie simili</p>', CONSENT_MARKUP);
  assert.match('<p>Wir verwenden Cookies</p>', CONSENT_MARKUP);
  assert.doesNotMatch('<article><p>Una ricetta per i biscotti al burro.</p></article>', CONSENT_MARKUP);
});

test('ACCEPT_SELECTORS: carries the accept control of each added vendor', () => {
  for (const sel of ['a.rcb-btn-accept-all', '.cmplz-accept', '.iubenda-cs-accept-btn', '.cky-btn-accept']) {
    assert.ok(ACCEPT_SELECTORS.includes(sel), sel);
  }
});
