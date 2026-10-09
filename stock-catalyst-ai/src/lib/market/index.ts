/** Public surface of the market-data layer. */

export * from './types.ts';
export * from './candles.ts';
export * from './csv.ts';
export * from './symbols.ts';
export * from './provenance.ts';
export * from './cache.ts';
export * from './validators.ts';
export { httpRequest, isAllowedHost, classifyHttpFailure, parseRetryAfter, ALLOWED_PROVIDER_HOSTS, ALLOWED_AI_HOSTS } from './http.ts';
export type { FetchLike, HttpResponse, HttpRequestOptions, HttpFailure } from './http.ts';
export { StooqProvider } from './stooq.ts';
export { FinnhubProvider } from './finnhub.ts';
export { AlphaVantageProvider, detectSoftError } from './alpha-vantage.ts';
export { TwelveDataProvider, detectTwelveDataError } from './twelve-data.ts';
export { DemoProvider, demoProvider, demoCandles, hashSymbol } from './demo.ts';
export { MarketDataRegistry, defaultProviders, getRegistry, resetRegistry } from './registry.ts';
export type { RegistryOptions, FetchEvent } from './registry.ts';
export { createProviderDeps, providerError, acquireSlot, buildProvenance, errorFromResponse } from './provider-base.ts';
export type { ProviderDeps } from './provider-base.ts';