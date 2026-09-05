// tests/unit/danger.test.js
// El guard DANGER es lo ÚNICO que decide si Hannah te pide confirmación antes de ejecutar
// un comando destructivo (run_command y las skills `terminal`). Un falso negativo tras
// retocar el regex borra archivos en silencio, así que se testea explícitamente.
import { DANGER } from '../../src/pipeline/tools.js';

// Comandos que DEBEN pedir confirmación.
const PELIGROSOS = [
    'rm archivo.txt',
    'rm -rf /tmp/x',
    'rm -r carpeta',
    'rm "/home/user/notas.txt"',
    'rmdir vacía',
    'unlink archivo',
    'del archivo.txt',
    'Remove-Item C:\\temp',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:',                 // fork bomb
    'echo hola > /dev/sda',
    'chmod -R 000 /etc',
    'shutdown -h now',
    'reboot',
    'poweroff',
    'git push --force origin main',
    'sudo rm -rf /',
    // el patrón no está anclado: también matchea si va segundo en una cadena
    'ls && rm -rf /tmp/x',
];

// Comandos benignos que NO deben molestar al usuario con un modal.
const BENIGNOS = [
    'ls -la',
    'pwd',
    'whoami',
    'uname -r',
    'free -h',
    'df -h',
    'git status -sb',
    'git log --oneline -10',
    'echo hola',
    'echo hola > /dev/null',          // /dev/null está excluido a propósito
    'cat notas.txt',
    'ping -c 3 google.com',
    'curl -s ifconfig.me',
    'touch nuevo.txt',
    'mkdir carpeta',
    'ps aux | head',
    'python3 --version',
    'ssh user@host',
    'grep -rn "rm" .',                // menciona rm pero no lo ejecuta como comando
];

describe('DANGER (guard de confirmación)', () => {
    test.each(PELIGROSOS)('pide confirmación: %s', (cmd) => {
        DANGER.lastIndex = 0;
        expect(DANGER.test(cmd)).toBe(true);
    });

    test.each(BENIGNOS)('NO molesta con: %s', (cmd) => {
        DANGER.lastIndex = 0;
        expect(DANGER.test(cmd)).toBe(false);
    });

    test('es case-insensitive (RM / Rm también)', () => {
        expect(DANGER.test('RM -RF /tmp/x')).toBe(true);
        expect(DANGER.test('ShutDown now')).toBe(true);
    });
});
