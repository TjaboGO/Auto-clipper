import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword, loginFailed, loginSucceeded, loginWait, newSession, requestAllowed, SESSION_COOKIE, validSession } from './auth';

function withPassword(password: string | undefined, run: () => Promise<void>) {
  const before = process.env.APP_PASSWORD;
  if (password === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = password;
  return run().finally(() => {
    if (before === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = before;
  });
}

const request = (cookie?: string, authorization?: string) => ({
  headers: new Headers(authorization ? { authorization } : {}),
  cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? { value: cookie } : undefined) },
});

test('without a password everything is open', () =>
  withPassword(undefined, async () => {
    assert.equal(await requestAllowed(request()), true);
    assert.equal(await checkPassword('anything'), true);
  }));

test('the password, a session cookie or a bearer token lets you in', () =>
  withPassword('hemligt-123', async () => {
    assert.equal(await checkPassword('hemligt-123'), true);
    assert.equal(await checkPassword('hemligt-12'), false);
    assert.equal(await requestAllowed(request()), false);
    const session = await newSession();
    assert.equal(await validSession(session), true);
    assert.equal(await requestAllowed(request(session)), true);
    assert.equal(await requestAllowed(request(undefined, 'Bearer hemligt-123')), true);
    assert.equal(await requestAllowed(request(undefined, 'Bearer fel')), false);
    // Tampered, expired, or made with another password: no.
    const [expires, sig] = session.split('.');
    assert.equal(await validSession(`${Number(expires) + 1}.${sig}`), false);
    assert.equal(await validSession(await newSession(Date.now() - 31 * 24 * 3600 * 1000)), false);
    assert.equal(await validSession('garbage'), false);
    await withPassword('nytt-lösenord', async () => {
      assert.equal(await validSession(session), false);
    });
  }));

test('after five wrong passwords, the next try has to wait, longer each time', () => {
  const now = 1_000_000;
  for (let i = 0; i < 4; i++) loginFailed('1.2.3.4', now);
  assert.equal(loginWait('1.2.3.4', now), 0);
  loginFailed('1.2.3.4', now);
  assert.equal(loginWait('1.2.3.4', now), 2);
  loginFailed('1.2.3.4', now);
  assert.equal(loginWait('1.2.3.4', now), 4);
  assert.equal(loginWait('1.2.3.4', now + 5000), 0);
  assert.equal(loginWait('5.6.7.8', now), 0);
  loginSucceeded('1.2.3.4');
  assert.equal(loginWait('1.2.3.4', now), 0);
});
