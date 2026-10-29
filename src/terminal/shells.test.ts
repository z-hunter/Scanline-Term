import { describe, expect, it } from 'vitest';
import { resolveShellLaunch, shellIdentity, splitShellCatalog, type ShellInfo } from './shells';

describe('shell catalog', () => {
  const profileA: ShellInfo = { id: 'lua:a', name: 'PowerShell (work)', command: 'pwsh.exe', args: ['-NoLogo', '-NoExit'] };
  const profileB: ShellInfo = { id: 'lua:b', name: 'PowerShell (clean)', command: 'pwsh.exe', args: ['-NoLogo'] };

  it('uses stable IDs across renames and keeps same-executable profiles distinct', () => {
    expect(shellIdentity({ ...profileA, name: 'Renamed profile' })).toBe('lua:a');
    expect(shellIdentity(profileA)).not.toBe(shellIdentity(profileB));
    expect(resolveShellLaunch('lua:a', [profileA, profileB])).toEqual({ command: 'pwsh.exe', args: profileA.args });
    expect(resolveShellLaunch('lua:b', [profileA, profileB])).toEqual({ command: 'pwsh.exe', args: profileB.args });
  });

  it('fails when a selected custom shell disappeared, but keeps legacy executable defaults', () => {
    expect(() => resolveShellLaunch('lua:missing', [])).toThrow('Default shell is unavailable: lua:missing');
    expect(resolveShellLaunch('C:\\shell.exe', [])).toEqual({ command: 'C:\\shell.exe' });
  });

  it('preserves an explicit command and its arguments over the default profile', () => {
    expect(resolveShellLaunch('lua:a', [profileA], { command: 'cmd.exe', args: ['/K', 'echo ok'] }))
      .toEqual({ command: 'cmd.exe', args: ['/K', 'echo ok'] });
    expect(resolveShellLaunch('lua:a', [profileA], { args: [] })).toEqual({ command: 'pwsh.exe', args: [] });
  });

  it('splits detected and custom shells while preserving catalog order', () => {
    const detected = { name: 'Detected', command: 'powershell.exe' };
    expect(splitShellCatalog([detected, profileA, profileB])).toEqual({ automatic: [detected], user: [profileA, profileB] });
  });
});
