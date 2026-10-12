import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
// Capacitor's Android library compiles for Java 21, and the Gradle wrapper
// cannot run on newer JDKs (Groovy fails with "Unsupported class file major
// version"), so the Android build needs exactly JDK 21.
const required = 21;
const suffix = process.platform === 'win32' ? '.exe' : '';
const fromHome = (home) => path.join(home, 'bin', `java${suffix}`);
// macOS `java_home -v 21` prints the default JDK and exits 0 when no JDK 21 is
// registered, so every candidate is identified by asking the JVM itself.
function* candidates() {
  for (const home of [process.env.JAVA_HOME_21_X64, process.env.JAVA_HOME])
    if (home) yield fromHome(home);
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/libexec/java_home', ['-v', `${required}`], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.trim()) yield fromHome(result.stdout.trim());
    // Homebrew's keg-only openjdk@21 is not registered with java_home.
    for (const prefix of ['/opt/homebrew', '/usr/local'])
      yield fromHome(`${prefix}/opt/openjdk@${required}/libexec/openjdk.jdk/Contents/Home`);
    yield fromHome('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
  }
  if (process.platform === 'win32')
    yield fromHome('C:\\Program Files\\Android\\Android Studio\\jbr');
  yield `java${suffix}`;
}
function inspect(java) {
  if (path.isAbsolute(java) && !existsSync(java)) return undefined;
  const result = spawnSync(java, ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return undefined;
  const home = /^\s*java\.home = (.+)$/m.exec(result.stderr)?.[1].trim();
  const version = /^\s*java\.specification\.version = (\S+)$/m.exec(result.stderr)?.[1];
  return home && version ? { home, major: Number.parseInt(version, 10) } : undefined;
}
/** Returns the home of an installed JDK 21, or throws naming the JDKs it found. */
export function findJdk21() {
  const found = new Map();
  for (const java of candidates()) {
    const jdk = inspect(java);
    if (!jdk || found.has(jdk.home)) continue;
    found.set(jdk.home, jdk.major);
    if (jdk.major === required && existsSync(path.join(jdk.home, 'bin', `javac${suffix}`)))
      return jdk.home;
  }
  const seen = [...found].map(([home, major]) => `JDK ${major} at ${home}`).join('; ');
  throw new Error(
    `Android builds need JDK ${required}${seen ? ` (found ${seen})` : ''}. ` +
      `Install it (for example \`brew install openjdk@${required}\`) or set JAVA_HOME to one.`,
  );
}
