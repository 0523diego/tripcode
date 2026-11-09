import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SafeFetchError, fetchPublicHttps, isPrivateAddress } from './safe-fetch.ts';

const OPTS = { maxBytes: 1000, accept: '*/*', userAgent: 'test' };
const publicLookup = async () => ['93.184.216.34'];
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

test('private, loopback, link-local and reserved addresses are recognised; public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.255.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('only public https addresses are fetched', async () => {
  const never = async () => {
    throw new Error('must not be called');
  };
  const deps = { fetch: never, lookup: publicLookup };
  for (const url of ['http://example.com/', 'file:///etc/passwd', 'https://localhost/', 'https://foo.localhost/', 'https://printer.local/', 'https://intranet/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data', 'https://user:pw@example.com/', 'https://example.com:8443/', 'ftp://example.com/']) {
    await assert.rejects(fetchPublicHttps(url, OPTS, deps), SafeFetchError, url);
  }
  // A public-looking name that resolves to a private address is refused too.
  await assert.rejects(fetchPublicHttps('https://sneaky.example.com/', OPTS, { fetch: never, lookup: async () => ['10.0.0.5'] }), /內部網路/);
  await assert.rejects(fetchPublicHttps('https://nowhere.example.com/', OPTS, { fetch: never, lookup: async () => [] }), /找不到這個網站/);
});

test('a redirect is checked again, and too many redirects stop', async () => {
  let calls = 0;
  const toInternal = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } });
  };
  await assert.rejects(fetchPublicHttps('https://example.com/', OPTS, { fetch: toInternal, lookup: publicLookup }), /內部網路/);
  assert.equal(calls, 1);
  const loop = async () => new Response(null, { status: 301, headers: { location: 'https://example.com/again' } });
  await assert.rejects(fetchPublicHttps('https://example.com/', OPTS, { fetch: loop, lookup: publicLookup }), /轉址太多次/);
  const ok = async (u: string) => (u === 'https://example.com/' ? new Response(null, { status: 301, headers: { location: '/real' } }) : reply('hello'));
  const r = await fetchPublicHttps('https://example.com/', OPTS, { fetch: ok, lookup: publicLookup });
  assert.equal(r.url, 'https://example.com/real');
  assert.equal(new TextDecoder().decode(r.bytes), 'hello');
});

test('a body over the cap is refused, whether it says so up front or just keeps coming', async () => {
  const big = 'x'.repeat(1500);
  await assert.rejects(fetchPublicHttps('https://example.com/', OPTS, { fetch: async () => reply(big), lookup: publicLookup }), /檔案太大/);
  await assert.rejects(fetchPublicHttps('https://example.com/', OPTS, { fetch: async () => reply('tiny', { headers: { 'content-length': '5000' } }), lookup: publicLookup }), /檔案太大/);
  await assert.rejects(fetchPublicHttps('https://example.com/', OPTS, { fetch: async () => new Response('no', { status: 404 }), lookup: publicLookup }), /404/);
});
