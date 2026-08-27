/**
 * 公共抽象（认证头提供器 / fetch 注入）的单元测试。
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import {
  bearerTokenProvider,
  resolveAuthHeaders,
  AUTHORIZATION_HEADER,
} from '../src/common/auth.ts';
import { isChallengeResponse, withAuthHeaders, type FetchLike } from '../src/common/fetch.ts';
import { AuthError, isAuthError } from '../src/common/errors.ts';

describe('resolveAuthHeaders', () => {
  it('静态对象原样返回', async () => {
    await expect(resolveAuthHeaders({ 'X-Key': 'v' })).resolves.toEqual({ 'X-Key': 'v' });
  });

  it('函数形式每次动态求值', async () => {
    let token = 'a';
    const provider = async () => ({ [AUTHORIZATION_HEADER]: `Bearer ${token}` });
    await expect(resolveAuthHeaders(provider)).resolves.toEqual({ authorization: 'Bearer a' });
    token = 'b';
    await expect(resolveAuthHeaders(provider)).resolves.toEqual({ authorization: 'Bearer b' });
  });

  it('返回空值视为无认证头', async () => {
    await expect(resolveAuthHeaders(async () => null)).resolves.toEqual({});
    await expect(resolveAuthHeaders(async () => undefined)).resolves.toEqual({});
  });
});

describe('bearerTokenProvider', () => {
  it('令牌存在时产出 Bearer 头', async () => {
    const provider = bearerTokenProvider(async () => 'tok-1');
    await expect(provider()).resolves.toEqual({ authorization: 'Bearer tok-1' });
  });

  it('令牌缺失时产出空头', async () => {
    const provider = bearerTokenProvider(async () => null);
    await expect(provider()).resolves.toEqual({});
    const empty = bearerTokenProvider(async () => '');
    await expect(empty()).resolves.toEqual({});
  });
});

describe('withAuthHeaders', () => {
  /** 记录每次请求的 init.headers 的桩 fetch。 */
  type HeadersArg = ConstructorParameters<typeof Headers>[0];
  function captureFetch(seen: Array<HeadersArg | undefined>): FetchLike {
    return async (_input, init) => {
      seen.push(init?.headers);
      return new Response('ok', { status: 200 });
    };
  }

it('为每个请求附加认证头并合并原有头', async () => {
    const seen: Array<HeadersArg | undefined> = [];
    const wrapped = withAuthHeaders(captureFetch(seen), {
      [AUTHORIZATION_HEADER]: 'Bearer tok',
      'X-Tenant': 't1',
    });
    await wrapped('https://example.com', { headers: { 'X-Other': 'o' } });

    expect(seen).toHaveLength(1);
    const headers = new Headers(seen[0]);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('X-Tenant')).toBe('t1');
    expect(headers.get('X-Other')).toBe('o');
  });

  it('认证头覆盖同名原有头（认证优先）', async () => {
    const seen: Array<HeadersArg | undefined> = [];
    const wrapped = withAuthHeaders(captureFetch(seen), {
      [AUTHORIZATION_HEADER]: 'Bearer new',
    });
    await wrapped('https://example.com', { headers: { authorization: 'Bearer old' } });
    expect(new Headers(seen[0]).get('authorization')).toBe('Bearer new');
  });
});

describe('isChallengeResponse', () => {
  it('401/403 视为挑战', () => {
    expect(isChallengeResponse(401)).toBe(true);
    expect(isChallengeResponse(403)).toBe(true);
    expect(isChallengeResponse(200)).toBe(false);
    expect(isChallengeResponse(500)).toBe(false);
  });
});

describe('AuthError', () => {
  it('携带归一的错误码', () => {
    const error = new AuthError('unauthorized', '凭据无效', { source: 'acp' });
    expect(error.code).toBe('unauthorized');
    expect(error.source).toBe('acp');
    expect(isAuthError(error)).toBe(true);
    expect(isAuthError(new Error('x'))).toBe(false);
  });
});