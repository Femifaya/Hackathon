import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeSecret, loadConfig, publicConfigSummary } from '../../src/lib/config/env.ts';

describe('loadConfig', () => {
  it('applies safe defaults when nothing is set', () => {
    const config = loadConfig({});
    assert.equal(config.appEnv, 'development');
    assert.equal(config.demoMode, false);
    assert.equal(config.database.path, './data/stock-catalyst.sqlite');
    assert.equal(config.database.autoMigrate, true);
    assert.equal(config.qwen.isConfigured, false);
    assert.equal(config.qwen.model, 'qwen-plus');
    assert.equal(config.qwen.timeoutMs, 45_000);
    assert.equal(config.qwen.maxRetries, 2);
    assert.equal(config.qwen.strictValidation, true);
    assert.deepEqual(config.providers.order, ['stooq', 'finnhub', 'alphavantage', 'twelvedata', 'demo']);
    assert.equal(config.cache.staleAfterSeconds, 900);
    assert.equal(config.rateLimit.aiMaxRequests, 6);
    assert.equal(config.ui.defaultRiskTolerance, 'medium');
    assert.deepEqual(config.warnings, []);
  });

  it('keeps demo data last so it can never shadow a real provider', () => {
    const config = loadConfig({ MARKET_DATA_PROVIDER: 'demo,finnhub' });
    assert.deepEqual(config.providers.order, ['demo', 'finnhub']);
    const auto = loadConfig({ MARKET_DATA_PROVIDER: 'auto' });
    assert.equal(auto.providers.order[auto.providers.order.length - 1], 'demo');
  });

  it('forces demo-only mode and disables auto-migration in production', () => {
    const config = loadConfig({ DEMO_MODE: 'true', APP_ENV: 'production' });
    assert.deepEqual(config.providers.order, ['demo']);
    assert.equal(config.demoMode, true);
    assert.equal(config.database.autoMigrate, false);
  });

  it('ignores unknown providers and falls back when nothing resolves', () => {
    const config = loadConfig({ MARKET_DATA_PROVIDER: 'yahoo,robinhood' });
    assert.deepEqual(config.providers.order, ['stooq', 'finnhub', 'alphavantage', 'twelvedata', 'demo']);
    assert.match(config.warnings.join(' '), /unknown provider "yahoo"/);
    assert.match(config.warnings.join(' '), /falling back to auto order/);
  });

  it('rejects malformed numbers and records a warning with the fallback used', () => {
    const config = loadConfig({
      QWEN_TIMEOUT_MS: 'banana',
      QWEN_MAX_RETRIES: '99',
      QWEN_TEMPERATURE: '5',
      CACHE_TTL_QUOTE_SECONDS: '-10',
      RATE_LIMIT_MAX_REQUESTS: '1e9',
    });
    assert.equal(config.qwen.timeoutMs, 45_000);
    assert.equal(config.qwen.maxRetries, 2);
    assert.equal(config.qwen.temperature, 0.2);
    assert.equal(config.cache.ttlQuoteSeconds, 60);
    assert.equal(config.rateLimit.maxRequests, 60);
    assert.equal(config.warnings.length, 5);
  });

  it('parses booleans from the common spellings and warns otherwise', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
      assert.equal(loadConfig({ QWEN_STRICT_VALIDATION: truthy }).qwen.strictValidation, true);
    }
    for (const falsy of ['0', 'false', 'no', 'off']) {
      assert.equal(loadConfig({ QWEN_STRICT_VALIDATION: falsy }).qwen.strictValidation, false);
    }
    const config = loadConfig({ QWEN_STRICT_VALIDATION: 'maybe' });
    assert.equal(config.qwen.strictValidation, true);
    assert.match(config.warnings.join(' '), /is not a boolean/);
  });

  it('validates the Qwen base URL and rejects a non-http scheme', () => {
    const good = loadConfig({ QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/' });
    assert.equal(good.qwen.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    const bad = loadConfig({ QWEN_BASE_URL: 'file:///etc/passwd' });
    assert.equal(bad.qwen.baseUrl, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    assert.match(bad.warnings.join(' '), /not a valid http\(s\) URL/);
  });

  it('marks the AI layer configured only when a key is present', () => {
    assert.equal(loadConfig({ QWEN_API_KEY: '   ' }).qwen.isConfigured, false);
    assert.equal(loadConfig({ QWEN_API_KEY: 'sk-test' }).qwen.isConfigured, true);
  });
});

describe('publicConfigSummary', () => {
  it('never leaks a secret value', () => {
    const secret = 'sk-super-secret-value-1234567890';
    const config = loadConfig({
      QWEN_API_KEY: secret,
      FINNHUB_API_KEY: 'fh-secret-value',
      ALPHAVANTAGE_API_KEY: 'av-secret-value',
      TWELVEDATA_API_KEY: 'td-secret-value',
    });
    const summary = publicConfigSummary(config);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('fh-secret-value'));
    assert.ok(!serialized.includes('av-secret-value'));
    assert.ok(!serialized.includes('td-secret-value'));
    assert.equal(summary.ai.configured, true);
    assert.equal(summary.ai.baseUrlHost, 'dashscope-intl.aliyuncs.com');
    assert.equal(summary.providers.keys.finnhub, 'configured');
  });

  it('describes a secret as configured or missing', () => {
    assert.equal(describeSecret('x'), 'configured');
    assert.equal(describeSecret(null), 'missing');
  });
});