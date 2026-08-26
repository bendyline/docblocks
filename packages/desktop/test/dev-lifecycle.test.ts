import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface DevLifecycleModule {
  SUPERVISOR_PORT_ENV: string;
  SUPERVISOR_TOKEN_ENV: string;
  notifyDevSupervisor: (exitCode: number, environment?: NodeJS.ProcessEnv) => Promise<boolean>;
  parseSupervisorPort: (value: unknown) => number | undefined;
  parseSupervisorToken: (value: unknown) => string | undefined;
}

interface DevCommand {
  kill: (signal: string) => void;
}

interface ConcurrentlyRun {
  commands: DevCommand[];
  result: Promise<unknown>;
}

interface ConcurrentlyCommandSpec {
  command: string;
  env?: Record<string, string>;
  name: string;
  prefixColor: string;
}

interface ConcurrentlyOptions {
  killOthers: string[];
  prefix: string;
}

interface DevSupervisorModule {
  runDesktopDev: (options: {
    concurrentlyImpl: (
      commands: ConcurrentlyCommandSpec[],
      options: ConcurrentlyOptions,
    ) => ConcurrentlyRun;
    processRef: EventEmitter & { pid: number };
  }) => Promise<number>;
}

const lifecycle = require('../scripts/dev-lifecycle.cjs') as DevLifecycleModule;
const { runDesktopDev } = require('../scripts/dev.cjs') as DevSupervisorModule;

describe('desktop development lifecycle', () => {
  it('rejects invalid lifecycle channel coordinates', async () => {
    expect(await lifecycle.notifyDevSupervisor(0, {})).to.equal(false);
    for (const value of ['', '0', '-1', '12x', '1.5', '65536']) {
      expect(lifecycle.parseSupervisorPort(value)).to.equal(undefined);
    }
    expect(lifecycle.parseSupervisorPort('31415')).to.equal(31415);
    expect(lifecycle.parseSupervisorToken('a'.repeat(64))).to.equal('a'.repeat(64));
    expect(lifecycle.parseSupervisorToken('not-a-token')).to.equal(undefined);
  });

  it('stops both development process trees when the app closes', async () => {
    const processRef = Object.assign(new EventEmitter(), { pid: 27182 });
    const killedSignals: string[][] = [[], []];
    let rejectRun: ((reason: Error) => void) | undefined;
    let stopped = false;
    const commands = killedSignals.map<DevCommand>((signals) => ({
      kill: (signal) => {
        signals.push(signal);
        if (stopped) return;
        stopped = true;
        rejectRun?.(new Error('commands stopped by supervisor'));
      },
    }));
    let commandSpecs: ConcurrentlyCommandSpec[] = [];
    let options: ConcurrentlyOptions | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const result = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });

    const devResult = runDesktopDev({
      processRef,
      concurrentlyImpl: (capturedCommands, capturedOptions) => {
        commandSpecs = capturedCommands;
        options = capturedOptions;
        markStarted?.();
        return { commands, result };
      },
    });

    await started;
    const environment = commandSpecs[1]?.env;
    expect(environment).not.to.equal(undefined);
    expect(await lifecycle.notifyDevSupervisor(0, environment)).to.equal(true);
    const exitCode = await devResult;

    expect(exitCode).to.equal(0);
    expect(killedSignals).to.deep.equal([['SIGTERM'], ['SIGTERM']]);
    expect(environment?.[lifecycle.SUPERVISOR_PORT_ENV]).to.match(/^\d+$/u);
    expect(environment?.[lifecycle.SUPERVISOR_TOKEN_ENV]).to.match(/^[a-f\d]{64}$/u);
    expect(options).to.deep.equal({ killOthers: ['failure'], prefix: 'name' });
    expect(processRef.listenerCount('SIGTERM')).to.equal(0);
  });

  it('preserves a startup failure when no shutdown was requested', async () => {
    const processRef = Object.assign(new EventEmitter(), { pid: 16180 });

    const exitCode = await runDesktopDev({
      processRef,
      concurrentlyImpl: () => ({
        commands: [],
        result: Promise.reject(new Error('Vite failed to bind')),
      }),
    });

    expect(exitCode).to.equal(1);
  });
});
