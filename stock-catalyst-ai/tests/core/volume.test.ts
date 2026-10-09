import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { averageVolume, volumeTrend, volumeSignal } from '../../src/lib/indicators/volume.ts';

describe('average volume', () => {
  it('is null until the window fills', () => {
    assert.deepEqual(averageVolume([1, 2, 3], 5), [null, null, null]);
  });

  it('rolls the window forward', () => {
    assert.deepEqual(averageVolume([10, 20, 30, 40], 2), [null, 15, 25, 35]);
  });
});

describe('volume trend', () => {
  it('reports a rising trend and an expansion ratio above 1', () => {
    const volumes: number[] = [];
    for (let index = 0; index < 30; index += 1) volumes.push(1_000_000 + index * 100_000);
    const result = volumeTrend(volumes, 20);
    assert.equal(result.direction, 'rising');
    assert.ok(result.slopePercentPerBar !== null && result.slopePercentPerBar > 2);
    assert.ok(result.latestRatio !== null && result.latestRatio > 1);
    assert.equal(result.complete, true);
  });

  it('reports a falling trend for contracting volume', () => {
    const volumes: number[] = [];
    for (let index = 0; index < 30; index += 1) volumes.push(4_000_000 - index * 100_000);
    assert.equal(volumeTrend(volumes, 20).direction, 'falling');
  });

  it('reports flat for a constant series', () => {
    const result = volumeTrend(new Array(30).fill(2_000_000), 20);
    assert.equal(result.direction, 'flat');
    assert.ok(Math.abs((result.latestRatio as number) - 1) < 1e-9);
  });

  it('marks the signal insufficient when the series has missing volume', () => {
    const result = volumeTrend(new Array(30).fill(0), 20, false);
    assert.equal(result.direction, 'insufficient_data');
    assert.equal(result.complete, false);
    assert.equal(volumeSignal(3, false), 'insufficient_data');
  });

  it('is insufficient when history is shorter than the period', () => {
    const result = volumeTrend([1, 2, 3], 20);
    assert.equal(result.latestAverage, null);
    assert.equal(result.latestRatio, null);
    assert.equal(result.direction, 'insufficient_data');
  });
});

describe('volume signal bands', () => {
  it('classifies expansion, contraction, and normal', () => {
    assert.equal(volumeSignal(1.8, true), 'expanding');
    assert.equal(volumeSignal(1.5, true), 'expanding');
    assert.equal(volumeSignal(0.5, true), 'contracting');
    assert.equal(volumeSignal(0.7, true), 'contracting');
    assert.equal(volumeSignal(1.1, true), 'normal');
    assert.equal(volumeSignal(null, true), 'insufficient_data');
  });
});