import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
}

const firebaseCliPath = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'firebase.cmd' : 'firebase',
);

function printBlock(title, body) {
  console.log(`\n[${title}]`);
  console.log(body);
}

const javaCheck = run('java', ['-version']);
const firebaseCheck = existsSync(firebaseCliPath)
  ? process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', `"${firebaseCliPath}" --version`])
    : run(firebaseCliPath, ['--version'])
  : { error: new Error('firebase-tools not installed') };

if (javaCheck.error) {
  printBlock(
    'Java',
    'No se encontro Java en PATH. Instala JDK 21 o superior para usar Firebase Emulator Suite.',
  );
} else {
  const javaOutput = `${javaCheck.stderr || ''}\n${javaCheck.stdout || ''}`;
  const majorMatch =
    javaOutput.match(/version "(\d+)(?:\.\d+)?/) || javaOutput.match(/version "1\.(\d+)/);
  const major = majorMatch ? Number(majorMatch[1]) : NaN;

  if (!Number.isFinite(major) || major < 21) {
    printBlock(
      'Java',
      `Version detectada:\n${javaOutput.trim()}\n\nNecesitas JDK 21 o superior para emuladores de Firebase.`,
    );
  } else {
    printBlock('Java', `OK\n${javaOutput.trim()}`);
  }
}

if (firebaseCheck.error) {
  printBlock(
    'Firebase CLI',
    'No se pudo ejecutar firebase-tools. Corre npm install antes de volver a intentar.',
  );
} else {
  printBlock('Firebase CLI', `OK\nVersion detectada: ${firebaseCheck.stdout.trim()}`);
}

console.log('\nSugerencias:');
console.log('- Reabre VS Code despues de cambiar JAVA_HOME o PATH.');
console.log('- Si la terminal integrada se cierra, prueba npm run firebase:emulators en PowerShell externo.');
console.log('- Si Auth falla, revisa Firebase Authentication > Google provider > Authorized domains.');
