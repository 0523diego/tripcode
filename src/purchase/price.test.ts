import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractAvailability, extractPrice, parseAmount } from './price.ts';

describe('parseAmount', () => {
  test('reads both decimal conventions', () => {
    assert.equal(parseAmount('1,234.56'), 1234.56);
    assert.equal(parseAmount('1.234,56'), 1234.56);
    assert.equal(parseAmount('€ 12,50'), 12.5);
    assert.equal(parseAmount('120'), 120);
    assert.equal(parseAmount('0.5'), 0.5);
    assert.equal(parseAmount('1,234'), 1234);
    assert.equal(parseAmount('1.234.567'), 1234567);
  });
  test('rejects non-numbers', () => {
    assert.equal(parseAmount('free'), undefined);
    assert.equal(parseAmount(''), undefined);
  });
});

const ld = (o: unknown) => `<html><script type="application/ld+json">${JSON.stringify(o)}</script></html>`;

describe('extractPrice', () => {
  test('JSON-LD offer', () => {
    const r = extractPrice(ld({ '@type': 'Product', offers: { '@type': 'Offer', price: '89.90', priceCurrency: 'eur' } }));
    assert.deepEqual(r, { amount: 89.9, currency: 'EUR', via: 'json-ld' });
  });
  test('several offers → the lowest, found anywhere in a @graph', () => {
    const r = extractPrice(ld({ '@graph': [{ '@type': 'Product', offers: [{ '@type': 'Offer', price: 120, priceCurrency: 'GBP' }, { '@type': 'Offer', price: 95, priceCurrency: 'GBP' }] }] }));
    assert.equal(r?.amount, 95);
  });
  test('AggregateOffer lowPrice', () => {
    assert.equal(extractPrice(ld({ '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: '45', priceCurrency: 'CHF' } }))?.amount, 45);
  });
  test('product meta tags in either attribute order', () => {
    const r = extractPrice('<meta content="64.00" property="product:price:amount"><meta property="product:price:currency" content="EUR">');
    assert.deepEqual(r, { amount: 64, currency: 'EUR', via: 'meta' });
  });
  test('itemprop', () => {
    const r = extractPrice('<meta itemprop="price" content="12.5"><meta itemprop="priceCurrency" content="USD">');
    assert.deepEqual(r, { amount: 12.5, currency: 'USD', via: 'itemprop' });
  });
  test('the user regex wins and uses the first capture group', () => {
    const html = ld({ '@type': 'Offer', price: 1 }) + '<span class="p">Adult €&nbsp;23,40</span>';
    assert.deepEqual(extractPrice(html, { regex: 'Adult[^\\d]*([\\d,.]+)' }), { amount: 23.4, via: 'regex' });
  });
  test('never guesses from loose text', () => {
    assert.equal(extractPrice('<p>Only today €19.99!</p>'), undefined);
  });
  test('a broken JSON-LD block is skipped', () => {
    assert.equal(extractPrice('<script type="application/ld+json">{oops</script>'), undefined);
  });
});

describe('extractAvailability', () => {
  test('from JSON-LD', () => {
    assert.equal(extractAvailability(ld({ '@type': 'Offer', price: 1, availability: 'https://schema.org/InStock' })), true);
    assert.equal(extractAvailability(ld({ '@type': 'Offer', price: 1, availability: 'https://schema.org/SoldOut' })), false);
    assert.equal(extractAvailability('<p>hi</p>'), undefined);
  });
  test('from a regex', () => {
    assert.equal(extractAvailability('<button>Book now</button>', { regex: 'book now' }), true);
    assert.equal(extractAvailability('<button>Notify me</button>', { regex: 'book now' }), false);
  });
});
