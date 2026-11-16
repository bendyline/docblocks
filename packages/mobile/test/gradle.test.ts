import { expect } from 'chai';
import { classifyGradleFailure, runGradle } from '../scripts/gradle.mjs';

// Excerpts of Gradle failure reports. The rate-limit report is the one that
// failed the store release quality gate twice in a row on 2026-11-16.
const rateLimited = `FAILURE: Build failed with an exception.

* What went wrong:
A problem occurred configuring root project 'android'.
> Could not resolve all artifacts for configuration 'classpath'.
   > Could not resolve org.jetbrains.kotlin:kotlin-stdlib:2.2.0.
     Required by:
         root project : > com.android.tools.build:gradle:8.13.0
      > Could not resolve org.jetbrains.kotlin:kotlin-stdlib:2.2.0.
         > Could not get resource 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.pom'.
            > Could not GET 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.pom'. Received status code 429 from server: Too Many Requests
`;
const notFound = `FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:writeMobileConformanceClasspath'.
> Could not resolve all files for configuration ':app:mobileConformance'.
   > Could not find org.json:json:20250517.
     Searched in the following locations:
       - https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.pom
`;
const scriptError = `FAILURE: Build failed with an exception.

* Where:
Build file 'packages/mobile/android/app/build.gradle' line: 12

* What went wrong:
A problem occurred evaluating project ':app'.
> Could not find method implementatoin() for arguments [org.json:json:20250517] on object of type org.gradle.api.internal.artifacts.dsl.dependencies.DefaultDependencyHandler.
`;
const compileError = `FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileReleaseJavaWithJavac'.
> Compilation failed; see the compiler output below.
`;

describe('Gradle dependency-download retries', () => {
  describe('classifyGradleFailure', () => {
    it('retries a rate limit without revalidating the cache', () => {
      expect(classifyGradleFailure(rateLimited)).to.deep.equal({ refresh: false });
    });

    it('retries a cached not-found answer with a refresh', () => {
      expect(classifyGradleFailure(notFound)).to.deep.equal({ refresh: true });
    });

    it('does not retry build-script or compile errors', () => {
      expect(classifyGradleFailure(scriptError)).to.equal(undefined);
      expect(classifyGradleFailure(compileError)).to.equal(undefined);
      expect(classifyGradleFailure('')).to.equal(undefined);
    });
  });

  describe('runGradle', () => {
    function harness(results: Array<{ status: number | null; stderr?: string }>) {
      const calls: string[][] = [];
      const waits: number[] = [];
      const run = () =>
        runGradle(['--no-daemon', ':app:task'], {
          cwd: '.',
          env: {},
          delays: [30, 90, 180],
          spawn: (args: string[]) => {
            calls.push(args);
            const result = results.shift();
            if (!result) throw new Error('Gradle ran more often than the test expected.');
            return result;
          },
          wait: (seconds: number) => waits.push(seconds),
          log: () => {},
        });
      return { calls, waits, run };
    }

    it('runs once when Gradle succeeds', () => {
      const { calls, waits, run } = harness([{ status: 0 }]);
      run();
      expect(calls).to.deep.equal([['--no-daemon', ':app:task']]);
      expect(waits).to.deep.equal([]);
    });

    it('backs off through a rate limit without refreshing', () => {
      const { calls, waits, run } = harness([
        { status: 1, stderr: rateLimited },
        { status: 1, stderr: rateLimited },
        { status: 0 },
      ]);
      run();
      expect(waits).to.deep.equal([30, 90]);
      expect(calls.every((args) => !args.includes('--refresh-dependencies'))).to.equal(true);
    });

    it('refreshes only the attempt after a not-found answer', () => {
      const { calls, run } = harness([
        { status: 1, stderr: notFound },
        { status: 1, stderr: rateLimited },
        { status: 0 },
      ]);
      run();
      expect(calls).to.deep.equal([
        ['--no-daemon', ':app:task'],
        ['--refresh-dependencies', '--no-daemon', ':app:task'],
        ['--no-daemon', ':app:task'],
      ]);
    });

    it('gives up after the last delay', () => {
      const { calls, waits, run } = harness(
        Array.from({ length: 4 }, () => ({ status: 1, stderr: rateLimited })),
      );
      expect(run).to.throw('Gradle failed (1).');
      expect(calls).to.have.length(4);
      expect(waits).to.deep.equal([30, 90, 180]);
    });

    it('fails at once on an error a retry would repeat', () => {
      const { calls, waits, run } = harness([{ status: 1, stderr: compileError }]);
      expect(run).to.throw('Gradle failed (1).');
      expect(calls).to.have.length(1);
      expect(waits).to.deep.equal([]);
    });
  });
});
