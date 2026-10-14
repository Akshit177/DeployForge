const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Force simulator mode for tests
process.env.DOCKER_MODE = 'simulator';

const {
  isDockerAvailable,
  buildImage,
  createContainer,
  startContainer,
  inspectContainer,
  stopContainer,
  removeContainer,
  getMode,
} = require('../services/dockerClient.js');

describe('Docker Client — Simulator Mode', () => {
  it('reports simulator mode', () => {
    assert.equal(getMode(), 'simulator');
  });

  it('isDockerAvailable returns true in simulator', async () => {
    const available = await isDockerAvailable();
    assert.equal(available, true);
  });

  it('buildImage returns simulated imageId', async () => {
    const result = await buildImage('/tmp/fake-context', 'test-image:latest');
    assert.ok(result.imageId.startsWith('sim_img_'));
    assert.equal(result.imageName, 'test-image:latest');
  });

  it('createContainer returns simulated containerId', async () => {
    const result = await createContainer({
      imageName: 'test-image:latest',
      containerName: 'df-test-container',
      containerPort: 3000,
    });
    assert.ok(result.containerId.startsWith('sim_c_'));
    assert.equal(result.containerName, 'df-test-container');
  });

  it('startContainer returns started true', async () => {
    const result = await startContainer('sim_c_abc123');
    assert.equal(result.started, true);
  });

  it('inspectContainer returns running state with network IP', async () => {
    const result = await inspectContainer('sim_c_abc123');
    assert.equal(result.state, 'running');
    assert.equal(result.running, true);
    assert.ok(result.networkIp.startsWith('172.20.0.'));
  });

  it('stopContainer returns stopped true', async () => {
    const result = await stopContainer('sim_c_abc123');
    assert.equal(result.stopped, true);
  });

  it('removeContainer returns removed true', async () => {
    const result = await removeContainer('sim_c_abc123');
    assert.equal(result.removed, true);
  });

  it('createContainer enforces resource limits in config', async () => {
    const result = await createContainer({
      imageName: 'test-image:latest',
      containerName: 'df-limited',
      containerPort: 8080,
      env: { NODE_ENV: 'production', PORT: '8080' },
      networkName: 'deployforge-apps',
      resourceLimits: { memoryMB: 256, cpuShares: 128, pidsLimit: 50 },
    });
    assert.ok(result.containerId);
    assert.equal(result.containerName, 'df-limited');
  });
});
