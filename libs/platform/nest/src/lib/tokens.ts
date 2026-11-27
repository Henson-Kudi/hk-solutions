/**
 * Injection tokens for values that are created outside Nest and handed in.
 * Symbols, so two libs can never collide on a name.
 */
export const LOGGER = Symbol('hk.platform.logger');
export const HEALTH_REGISTRY = Symbol('hk.platform.health-registry');
export const METRICS = Symbol('hk.platform.metrics');
